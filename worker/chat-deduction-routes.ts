/**
 * チャットで推理の経路（issue #375）
 *
 * 配信者がアプリのページ（/chat-deduction/）から、報酬を作り、問題集を選んでゲームを始め、終える。
 * - GET /api/admin/chat-deduction: 控えた報酬のIDと、最後に始めたゲーム（終えたものも含む）を返す
 * - POST /api/admin/chat-deduction/rewards: 「質問」「解答」の報酬をTwitchで作り、IDを控える。もう作ってあれば409
 * - POST /api/admin/chat-deduction/games: 問題集（{ setId }）を選んでゲームを始め、2つの報酬を交換できるようにする。
 *   どの問題を出すかは Worker が問題集の中から決める（worker/chat-deduction-pick.ts。配信者も答えを知らずに参加するため）
 * - POST /api/admin/chat-deduction/games/:id/end: 2つの報酬を交換できないようにしてから、ゲームを終える（配信者が打ち切った）
 * - GET・PUT /api/admin/chat-deduction/sound: 場面ごとに鳴らす音の設定を読む・検証して保存する（worker/chat-deduction-sound.ts）
 *
 * 合成ページの素材「チャットで推理」（issue #378）は、オーバーレイ用キーで次の経路を使う。
 * - GET /api/overlay/chat-deduction: 最後に始めたゲームのカードの一覧を返す（worker/chat-deduction-board.ts）
 * - GET /api/overlay/chat-deduction/socket: 変わったカードの一覧を押し出してもらう WebSocket の接続を、配送先へ引き渡す
 * ゲームを始めた・終えたら、カードの一覧を押し出す。押し出せなくても始めた・終えたことは取り消さず、502で知らせる
 * （報酬の切り替えはもう済んでいるため。意見ボードと同じ扱い）。
 *
 * 注意: 報酬の切り替えに失敗したら、開始・終了を黙って進めない（方針4）。開始ではゲームを始めなかったことにし、
 * 終了ではゲームを開催中のまま残して、配信者がやり直せるようにする。
 */
import { CHAT_DEDUCTION_PROBLEMS, CHAT_DEDUCTION_PROBLEM_SETS } from '../src/chat-deduction/problem-set'
import { connectChatDeductionSocket } from './alert-channel'
import { pushLatestChatDeductionBoard, readChatDeductionBoard } from './chat-deduction-board'
import { loadChatDeductionSound, parseChatDeductionSound, saveChatDeductionSound } from './chat-deduction-sound'
import { pickChatDeductionProblem } from './chat-deduction-pick'
import { createChatDeductionRewards, loadChatDeductionRewards, setChatDeductionRewardsEnabled, type ChatDeductionRewards } from './chat-deduction-rewards'
import { cancelGame, endGame, readCurrentGame, readLatestGame, startGame, type ChatDeductionGame } from './chat-deduction-store'
import { HttpError, STATUS, requireAdmin, requireOverlayKey, type Context } from './http'
import { listMedia } from './media'
import { overlayKeyTag } from './overlay-key'
import { getManageToken } from './reward-routes'

/** 経路の :id として受け付ける書式（1以上の整数） */
const ID = /^[1-9][0-9]*$/

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const readJson = (context: Context): Promise<unknown> =>
  context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })

/**
 * 最後に始めたゲームのカードの一覧を合成ページへ押し出す。
 *
 * @param done 押し出せなかったときのメッセージに添える、もう済んだこと（「ゲームを始めました」など）
 * @throws HttpError 押し出せなければ502（済んだことは取り消さない）
 */
const pushBoard = async (context: Context, done: string): Promise<void> => {
  await pushLatestChatDeductionBoard(context.env.DB, context.env.STORE, context.env.ALERTS, CHAT_DEDUCTION_PROBLEMS).catch((error: unknown) => {
    throw new HttpError(STATUS.badGateway, 'chat-deduction-push-failed', `${done}が、合成ページへ知らせられませんでした（${reasonOf(error)}）`)
  })
}

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
 * POST /api/admin/chat-deduction/games: 問題集を選んでゲームを始め、2つの報酬を交換できるようにする。
 *
 * 問題は選んだ問題集の中から、最後に始めたゲームの問題を除いて乱数で決める。
 * 報酬を交換できるようにできなければ、ゲームを始めなかったことにし、報酬を交換できない状態へ戻してから502を返す。
 *
 * @throws HttpError 知らない問題集なら400、報酬が無い・ほかのゲームが開催中なら409、報酬を切り替えられなければ502
 * @throws AuthError channel:manage:redemptions の無いトークンしか無い
 */
export const postChatDeductionGame = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body = await readJson(context)
  const setId = typeof body === 'object' && body !== null && 'setId' in body ? body.setId : undefined
  const set = CHAT_DEDUCTION_PROBLEM_SETS.find((candidate) => candidate.id === setId)
  if (set === undefined) throw new HttpError(STATUS.badRequest, 'unknown-problem-set', `問題集「${String(setId)}」はありません`)
  const rewards = await requireRewards(context)
  const { env, twitch, now } = context
  // 行を作る前にトークンを確かめる（スコープが足りなければ、行を作らずにログインし直しを求める）
  const { accessToken } = await getManageToken(context)
  const previous = await readLatestGame(env.DB)
  const problem = pickChatDeductionProblem(set, previous?.problemId ?? null, Math.random)
  const game = await startGame(env.DB, problem.id, now)
  if (game === null) throw new HttpError(STATUS.conflict, 'chat-deduction-game-open', 'ほかのゲームが開催中です。先に終えてください')

  try {
    await setChatDeductionRewardsEnabled(twitch, accessToken, env.TWITCH_BROADCASTER_ID, rewards, true)
  } catch (error) {
    await cancelGame(env.DB, game.id)
    // 片方だけ交換できるようになっているかもしれないので戻す。戻せなければ、そのことも添えて知らせる
    const rollback = await setChatDeductionRewardsEnabled(twitch, accessToken, env.TWITCH_BROADCASTER_ID, rewards, false)
      .then(
        () => '',
        (rollbackError: unknown) => `。報酬を交換できない状態にも戻せませんでした（${reasonOf(rollbackError)}）。/rewards/ で確かめてください`,
      )
    throw new HttpError(STATUS.badGateway, 'chat-deduction-rewards-failed', `報酬を交換できるようにできなかったので、ゲームを始めませんでした（${reasonOf(error)}）${rollback}`)
  }
  await pushBoard(context, 'ゲームを始めました')
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
  await pushBoard(context, 'ゲームを終えました')
  return Response.json({ game } satisfies { game: ChatDeductionGame })
}

/** GET /api/admin/chat-deduction/sound: 場面ごとに鳴らす音の設定。未保存ならどの枠も鳴らさない設定が返る */
export const getChatDeductionSound = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json(await loadChatDeductionSound(context.env.STORE))
}

/**
 * PUT /api/admin/chat-deduction/sound: 音の設定を検証して保存し、保存したものを返す。
 * 合成ページへは押し出さない（次にゲームが動いたとき・読み直したときの一覧に載る）。
 *
 * @throws ConfigError 設定に問題がある場合（index.ts が問題点付きの400にする）
 */
export const putChatDeductionSound = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body = await readJson(context)
  const { env } = context
  const kinds = new Map((await listMedia(env.MEDIA)).map((item) => [item.id, item.kind]))
  const sound = parseChatDeductionSound(body, (mediaId) => kinds.get(mediaId) ?? null)
  await saveChatDeductionSound(env.STORE, sound)
  return Response.json(sound)
}

/** GET /api/overlay/chat-deduction?key=: 最後に始めたゲームのカードの一覧を返す（開催中は正解の表記を伏せる） */
export const getOverlayChatDeduction = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  return Response.json(await readChatDeductionBoard(context.env.DB, context.env.STORE, CHAT_DEDUCTION_PROBLEMS))
}

/** GET /api/overlay/chat-deduction/socket?key=: 合成ページからのWebSocketの接続を、カードの一覧を受け取る接続として配送先へ引き渡す */
export const chatDeductionSocket = async (context: Context): Promise<Response> => {
  const key = await requireOverlayKey(context)
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectChatDeductionSocket(context.env.ALERTS, context.request, await overlayKeyTag(key))
}
