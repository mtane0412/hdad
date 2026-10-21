/**
 * チャットで推理のゲームの開始（/chat-deduction/ のページとトリガーの動作 chatDeduction の共通部分）
 *
 * 行を作ってから「質問」「解答」の2つの報酬を交換できるようにし、合成ページへカードの一覧を押し出す。
 * トリガーのチャンネルポイントで始めたときは、ゲームのあいだその報酬（startRewardId）を交換できないようにし、
 * 行に控えて、終えるとき（打ち切り・正解）に交換できるように戻す。
 *
 * 注意: 報酬の切り替えに失敗したら、開始を黙って進めない（方針4）。ゲームを始めなかったことにし（行を消す）、
 * 報酬を元の状態へ戻してから502を投げる。戻せなかったことも黙らずメッセージに添える。
 * 注意: 合成ページへの押し出しに失敗しても、始めたことは取り消さずに502を投げる（報酬の切り替えはもう済んでいるため）。
 */
import type { ChatDeductionProblem } from '../src/chat-deduction/problems'
import { CHAT_DEDUCTION_IMAGES, CHAT_DEDUCTION_PROBLEM_SETS } from '../src/chat-deduction/problem-set'
import { pushLatestChatDeductionBoard } from './chat-deduction-board'
import { loadChatDeductionRewards, setChatDeductionRewardsEnabled, type ChatDeductionRewards } from './chat-deduction-rewards'
import { cancelGame, readLatestGame, startGame, type ChatDeductionGame } from './chat-deduction-store'
import { HttpError, STATUS, type Context } from './http'
import { getManageToken } from './reward-routes'

/** ゲームの開始に要る文脈（トリガーの実行からも呼べるよう、リクエストに関わる項目を含めない） */
export type ChatDeductionStartContext = Pick<Context, 'env' | 'twitch' | 'now'>

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * 最後に始めたゲームのカードの一覧を合成ページへ押し出す。
 *
 * @param done 押し出せなかったときのメッセージに添える、もう済んだこと（「ゲームを始めました」など）
 * @throws HttpError 押し出せなければ502（済んだことは取り消さない）
 */
export const pushChatDeductionBoard = async ({ env }: ChatDeductionStartContext, done: string): Promise<void> => {
  await pushLatestChatDeductionBoard(env.DB, env.STORE, env.ALERTS, CHAT_DEDUCTION_PROBLEM_SETS, CHAT_DEDUCTION_IMAGES).catch((error: unknown) => {
    throw new HttpError(STATUS.badGateway, 'chat-deduction-push-failed', `${done}が、合成ページへ知らせられませんでした（${reasonOf(error)}）`)
  })
}

/**
 * 控えた報酬のIDを読む。
 *
 * @throws HttpError まだ作っていなければ409
 */
export const requireChatDeductionRewards = async ({ env }: ChatDeductionStartContext): Promise<ChatDeductionRewards> => {
  const rewards = await loadChatDeductionRewards(env.STORE)
  if (rewards === null) throw new HttpError(STATUS.conflict, 'chat-deduction-rewards-missing', '先にチャットで推理の報酬を作ってください')
  return rewards
}

/**
 * ゲームを始め、2つの報酬を交換できるようにする（始めた報酬があれば交換できないようにする）。
 *
 * @param choose 出す問題を決める。直前のゲームの問題のID（一度も始めていなければ null）を受け取る
 * @param requestedStartRewardId トリガーのチャンネルポイントで始めたときの、その報酬のID。ページから始めたときは null。
 *   質問・解答の報酬そのものなら、始めた報酬として扱わない
 * @returns 始めたゲーム
 * @throws HttpError 報酬が無い・ほかのゲームが開催中なら409、報酬を切り替えられない・合成ページへ押し出せなければ502
 * @throws AuthError channel:manage:redemptions の無いトークンしか無い
 * @throws Error choose が投げた場合（指定した問題が問題集から消えていたなど）
 */
export const startChatDeductionGame = async (
  context: ChatDeductionStartContext,
  choose: (previousProblemId: string | null) => ChatDeductionProblem,
  requestedStartRewardId: string | null,
): Promise<ChatDeductionGame> => {
  const rewards = await requireChatDeductionRewards(context)
  // 「すべての報酬」の行で質問・解答の報酬が交換されて始まったときは、それを始めた報酬として止めない
  // （止めると、ゲームのあいだ質問・解答できなくなり、終えたら逆にゲームの外で交換できるようになってしまう）
  const isOwnReward = requestedStartRewardId === rewards.questionRewardId || requestedStartRewardId === rewards.answerRewardId
  const startRewardId = isOwnReward ? null : requestedStartRewardId
  const { env, twitch, now } = context
  // 行を作る前にトークンを確かめる（スコープが足りなければ、行を作らずにログインし直しを求める）
  const { accessToken } = await getManageToken(context)
  const previous = await readLatestGame(env.DB)
  const problem = choose(previous?.problemId ?? null)
  const game = await startGame(env.DB, problem.id, now, startRewardId)
  if (game === null) throw new HttpError(STATUS.conflict, 'chat-deduction-game-open', 'ほかのゲームが開催中です。先に終えてください')

  try {
    await setChatDeductionRewardsEnabled(twitch, accessToken, env.TWITCH_BROADCASTER_ID, rewards, true, startRewardId)
  } catch (error) {
    await cancelGame(env.DB, game.id)
    // 一部だけ切り替わっているかもしれないので戻す。戻せなければ、そのことも添えて知らせる
    const rollback = await setChatDeductionRewardsEnabled(twitch, accessToken, env.TWITCH_BROADCASTER_ID, rewards, false, startRewardId)
      .then(
        () => '',
        (rollbackError: unknown) => `。報酬を元の状態にも戻せませんでした（${reasonOf(rollbackError)}）。/rewards/ で確かめてください`,
      )
    throw new HttpError(STATUS.badGateway, 'chat-deduction-rewards-failed', `報酬を切り替えられなかったので、ゲームを始めませんでした（${reasonOf(error)}）${rollback}`)
  }
  await pushChatDeductionBoard(context, 'ゲームを始めました')
  return game
}
