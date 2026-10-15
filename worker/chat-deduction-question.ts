/**
 * チャットで推理の質問の受け口（issue #376）
 *
 * EventSub の Webhook に届いたチャンネルポイントの交換のうち、HDAD が作った「質問」の報酬（worker/chat-deduction-rewards.ts）
 * の交換を受ける（「解答」の報酬の交換は worker/chat-deduction-guess.ts へ振り分ける。issue #377）。流れは次のとおり。
 * 1. 交換のIDを鍵に質問の行を作り、受け付けるかどうか（開催中のゲーム・1問あたりの上限・同じ人の待ち時間）を同じ1つの文で決める
 *    （worker/chat-deduction-store.ts の reserveQuestion）。行がもうあれば再送なので何もしない（二重に答えない）
 * 2. Twitch へ2xxを返したあとで（waitUntil）、受け付けた質問には LLM に答えさせて D1 に書き、交換を FULFILLED にする。
 *    受け付けなかった質問と答えられなかった質問は、交換を CANCELED にして視聴者へポイントを返す。
 *    答えた質問はカードになるので、合成ページへカードの一覧を押し出す（issue #378。worker/chat-deduction-board.ts）
 *
 * 注意: LLM の応答を待つと Twitch への2xxが遅れて同じ通知を再送されるので、LLM と交換の更新は応答のあとに回す（aiChat と同じ）。
 *   応答のあとの失敗は投げても受け取る人がいないので、収集の失敗（collection_failures）として残す。
 * 注意: 交換の状態を更新できなかったとき（トークンのスコープ不足・Twitch の失敗）、交換は Twitch の待ち行列に未処理のまま残る。
 *   D1 の質問の行は書き戻さない（答えたことは事実なので）。配信者は Twitch の待ち行列で処理できる。
 */
import { CHAT_DEDUCTION_PROBLEMS } from '../src/chat-deduction/problem-set'
import { recordLateFailure } from './alert-actions'
import { answerChatDeductionQuestion } from './chat-deduction-answer'
import { pushBoardAfterRedemption } from './chat-deduction-board'
import { receiveChatDeductionGuess } from './chat-deduction-guess'
import { loadChatDeductionRewards, type ChatDeductionRewards } from './chat-deduction-rewards'
import { answerQuestion, failQuestion, readGame, reserveQuestion, type ChatDeductionQuestion, type ChatDeductionQuestionLimits } from './chat-deduction-store'
import { HttpError, STATUS, type Context } from './http'
import { getManageToken } from './reward-routes'
import { recordFailure } from './stats-store'
import type { RedemptionStatus } from './twitch'

/** チャンネルポイントの交換の通知の種類 */
const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'

/**
 * 質問を受け付ける上限（方針8。LLM の呼び出しの回数を、視聴者の数ではなくゲームの数で抑える）。
 *
 * 1問あたり30件あれば、はい・いいえの絞り込みで答えに届く。同じ人の待ち時間は、1人が続けて質問して上限を使い切らないための間隔。
 */
export const CHAT_DEDUCTION_QUESTION_LIMITS: ChatDeductionQuestionLimits = { maxQuestionsPerGame: 30, cooldownMs: 60 * 1000 }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const invalid = (message: string): HttpError => new HttpError(STATUS.badRequest, 'invalid-webhook', message)

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * 「質問」の交換の通知から、質問の行に書く項目を読む。
 *
 * @throws HttpError 交換のID・視聴者・質問の文字列が揃っていない場合（400。黙って捨てない）
 */
const readQuestionRedemption = (event: Record<string, unknown>) => {
  const { id, user_id: userId, user_login: userLogin, user_name: userName, user_input: question } = event
  if (typeof id !== 'string' || typeof userId !== 'string' || typeof userLogin !== 'string' || typeof userName !== 'string' || typeof question !== 'string') {
    throw invalid('チャットで推理の質問の交換の通知に id・user_id・user_login・user_name・user_input が揃っていません')
  }
  return { redemptionId: id, userId, userLogin, userName, question }
}

/**
 * 受け付けた質問に LLM で答えて D1 に書く。
 *
 * @returns 交換をどの状態にするか（答えられたら FULFILLED、答えられなかったら CANCELED）
 */
const answer = async (context: Context, question: ChatDeductionQuestion): Promise<RedemptionStatus> => {
  const { env, llm, now } = context
  try {
    const game = question.gameId === null ? null : await readGame(env.DB, question.gameId)
    const problem = CHAT_DEDUCTION_PROBLEMS.find((candidate) => candidate.id === game?.problemId)
    if (problem === undefined) throw new Error(`質問を受けたゲーム（${String(question.gameId)}）の問題が問題集にありません`)
    const result = await answerChatDeductionQuestion(llm, problem, question.question)
    if ((await answerQuestion(env.DB, question.id, result, now)) === null) throw new Error(`質問（${question.id}）がもう答え待ちではありませんでした`)
    return 'FULFILLED'
  } catch (error) {
    // 答えられなかった質問は失敗として残し、ポイントを返す
    await failQuestion(env.DB, question.id, reasonOf(error), now)
    await recordFailure(env.DB, 'chat-deduction-answer-failed', `${question.userName}さんの質問「${question.question}」に答えられませんでした: ${reasonOf(error)}`, now)
    return 'CANCELED'
  }
}

/**
 * 質問に答える（受け付けなかったなら答えない）。そのうえで交換を完了か取り消しにする。
 *
 * 交換を更新するトークンは LLM より先に取る。取れないまま LLM を呼ぶと、配信中にトークンが古いだけで
 * 質問ごとに LLM の枠を使い、交換は1件も処理されないためである。取れなければ答え待ちの質問を失敗として閉じてから投げる
 * （答え待ちのまま残すと、上限と待ち時間に数え続けてしまう）。
 */
const settle = async (context: Context, rewards: ChatDeductionRewards, question: ChatDeductionQuestion): Promise<void> => {
  const { accessToken } = await getManageToken(context).catch(async (error: unknown) => {
    if (question.status === 'pending') await failQuestion(context.env.DB, question.id, reasonOf(error), context.now)
    throw error
  })
  const status = question.status === 'pending' ? await answer(context, question) : 'CANCELED'
  // 答えられた質問だけがカードになる（受け付けなかった・答えられなかった質問では、映すものが変わらない）
  if (status === 'FULFILLED') await pushBoardAfterRedemption(context, `${question.userName}さんの質問「${question.question}」の答え`)
  await context.twitch.updateRedemptionStatus(accessToken, context.env.TWITCH_BROADCASTER_ID, rewards.questionRewardId, question.redemptionId, status)
}

/**
 * 届いた通知が「質問」の報酬の交換なら質問として受け、「解答」の報酬の交換なら解答として受ける（worker/chat-deduction-guess.ts）。
 * ほかの通知・ほかの報酬・ほかのチャンネルの交換では何もしない。
 *
 * @throws HttpError 「質問」「解答」の交換に必要な項目が揃っていない場合（400）
 */
export const handleChatDeductionRedemption = async (context: Context, type: string, event: unknown): Promise<void> => {
  const { env, now } = context
  if (type !== REDEMPTION || !isRecord(event) || event.broadcaster_user_id !== env.TWITCH_BROADCASTER_ID) return
  const rewards = await loadChatDeductionRewards(env.STORE)
  if (rewards === null || !isRecord(event.reward)) return
  if (event.reward.id === rewards.answerRewardId) return receiveChatDeductionGuess(context, rewards, event)
  if (event.reward.id !== rewards.questionRewardId) return

  const question = await reserveQuestion(env.DB, readQuestionRedemption(event), CHAT_DEDUCTION_QUESTION_LIMITS, now)
  // 行がもうある（同じ通知の再送）なら、最初に届いたときに答えている
  if (question === null) return
  context.waitUntil(recordLateFailure(context, 'chat-deduction-redemption-failed', () => settle(context, rewards, question)))
}
