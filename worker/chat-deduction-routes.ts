/**
 * チャットで推理の経路（issue #375）
 *
 * 配信者がアプリのページ（/chat-deduction/）から、報酬を作り、問題を選んでゲームを始め、終える。
 * - GET /api/admin/chat-deduction: 控えた報酬のIDと、最後に始めたゲーム（終えたものも含む）を返す
 * - POST /api/admin/chat-deduction/rewards: 「質問」「解答」の報酬をTwitchで作り、IDを控える。もう作ってあれば409
 * - POST /api/admin/chat-deduction/games: 問題（{ problemId }）を選んでゲームを始め、2つの報酬を交換できるようにする
 * - POST /api/admin/chat-deduction/games/:id/end: 2つの報酬を交換できないようにしてから、ゲームを終える（配信者が打ち切った）
 *
 * 注意: 報酬の切り替えに失敗したら、開始・終了を黙って進めない（方針4）。開始ではゲームを始めなかったことにし、
 * 終了ではゲームを開催中のまま残して、配信者がやり直せるようにする。
 */
import { CHAT_DEDUCTION_PROBLEMS } from '../src/chat-deduction/problem-set'
import { createChatDeductionRewards, loadChatDeductionRewards, setChatDeductionRewardsEnabled, type ChatDeductionRewards } from './chat-deduction-rewards'
import { cancelGame, endGame, readCurrentGame, readLatestGame, startGame, type ChatDeductionGame } from './chat-deduction-store'
import { HttpError, STATUS, requireAdmin, type Context } from './http'
import { getManageToken } from './reward-routes'

/** 経路の :id として受け付ける書式（1以上の整数） */
const ID = /^[1-9][0-9]*$/

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const readJson = (context: Context): Promise<unknown> =>
  context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })

/**
 * 控えた報酬のIDを読む。
 *
 * @throws HttpError まだ作っていなければ409
 */
const requireRewards = async (context: Context): Promise<ChatDeductionRewards> => {
  const rewards = await loadChatDeductionRewards(context.env.STORE)
  if (rewards === null) throw new HttpError(STATUS.conflict, 'chat-deduction-rewards-missing', '先にチャットで推理の報酬を作ってください')
  return rewards
}

/** GET /api/admin/chat-deduction: 控えた報酬のIDと、最後に始めたゲームを返す */
export const getChatDeduction = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const [rewards, game] = await Promise.all([loadChatDeductionRewards(context.env.STORE), readLatestGame(context.env.DB)])
  return Response.json({ rewards, game } satisfies { rewards: ChatDeductionRewards | null; game: ChatDeductionGame | null })
}

/**
 * POST /api/admin/chat-deduction/rewards: 「質問」「解答」の報酬をTwitchで作り、IDを控える。
 *
 * @throws HttpError もう作ってあれば409
 * @throws AuthError channel:manage:redemptions の無いトークンしか無い
 * @throws TwitchApiError Twitchが拒否した（同じ名前の報酬がある・50件の上限に達したなど）
 */
export const postChatDeductionRewards = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  if ((await loadChatDeductionRewards(context.env.STORE)) !== null) {
    throw new HttpError(STATUS.conflict, 'chat-deduction-rewards-exist', 'チャットで推理の報酬はもう作ってあります')
  }
  const { accessToken } = await getManageToken(context)
  const rewards = await createChatDeductionRewards(context.env.STORE, context.twitch, accessToken, context.env.TWITCH_BROADCASTER_ID)
  return Response.json({ rewards } satisfies { rewards: ChatDeductionRewards }, { status: STATUS.created })
}

/**
 * POST /api/admin/chat-deduction/games: 問題を選んでゲームを始め、2つの報酬を交換できるようにする。
 *
 * 報酬を交換できるようにできなければ、ゲームを始めなかったことにし、報酬を交換できない状態へ戻してから502を返す。
 *
 * @throws HttpError 問題集に無い問題なら400、報酬が無い・ほかのゲームが開催中なら409、報酬を切り替えられなければ502
 * @throws AuthError channel:manage:redemptions の無いトークンしか無い
 */
export const postChatDeductionGame = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body = await readJson(context)
  const problemId = typeof body === 'object' && body !== null && 'problemId' in body ? body.problemId : undefined
  if (typeof problemId !== 'string' || !CHAT_DEDUCTION_PROBLEMS.some((problem) => problem.id === problemId)) {
    throw new HttpError(STATUS.badRequest, 'unknown-problem', `問題「${String(problemId)}」は問題集にありません`)
  }
  const rewards = await requireRewards(context)
  const { env, twitch, now } = context
  const game = await startGame(env.DB, problemId, now)
  if (game === null) throw new HttpError(STATUS.conflict, 'chat-deduction-game-open', 'ほかのゲームが開催中です。先に終えてください')

  try {
    const { accessToken } = await getManageToken(context)
    await setChatDeductionRewardsEnabled(twitch, accessToken, env.TWITCH_BROADCASTER_ID, rewards, true)
  } catch (error) {
    await cancelGame(env.DB, game.id)
    // 片方だけ交換できるようになっているかもしれないので戻す。戻せなければ、そのことも添えて知らせる
    const rollback = await getManageToken(context)
      .then(({ accessToken }) => setChatDeductionRewardsEnabled(twitch, accessToken, env.TWITCH_BROADCASTER_ID, rewards, false))
      .then(
        () => '',
        (rollbackError: unknown) => `。報酬を交換できない状態にも戻せませんでした（${reasonOf(rollbackError)}）。/rewards/ で確かめてください`,
      )
    throw new HttpError(STATUS.badGateway, 'chat-deduction-rewards-failed', `報酬を交換できるようにできなかったので、ゲームを始めませんでした（${reasonOf(error)}）${rollback}`)
  }
  return Response.json({ game } satisfies { game: ChatDeductionGame }, { status: STATUS.created })
}

/**
 * POST /api/admin/chat-deduction/games/:id/end: 2つの報酬を交換できないようにしてから、ゲームを終える。
 *
 * 報酬を切り替えられなければゲームを終えない（交換できるまま終わったことにしない。やり直せるようにする）。
 *
 * @throws HttpError 開催中でないゲームなら404、報酬を切り替えられなければ502
 * @throws AuthError channel:manage:redemptions の無いトークンしか無い
 */
export const postEndChatDeductionGame = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const raw = context.params.id ?? ''
  const current = await readCurrentGame(context.env.DB)
  if (!ID.test(raw) || current === null || current.id !== Number(raw)) {
    throw new HttpError(STATUS.notFound, 'chat-deduction-game-not-open', `ゲーム「${raw}」は開催中ではありません（別の窓で終えられた可能性があります）`)
  }
  const rewards = await requireRewards(context)
  const { env, twitch, now } = context
  const { accessToken } = await getManageToken(context)
  await setChatDeductionRewardsEnabled(twitch, accessToken, env.TWITCH_BROADCASTER_ID, rewards, false).catch((error: unknown) => {
    throw new HttpError(STATUS.badGateway, 'chat-deduction-rewards-failed', `報酬を交換できないようにできなかったので、ゲームを終えていません（${reasonOf(error)}）`)
  })
  const game = await endGame(env.DB, current.id, 'stopped', now)
  if (game === null) throw new HttpError(STATUS.notFound, 'chat-deduction-game-not-open', `ゲーム「${raw}」は開催中ではありません（別の窓で終えられた可能性があります）`)
  return Response.json({ game } satisfies { game: ChatDeductionGame })
}
