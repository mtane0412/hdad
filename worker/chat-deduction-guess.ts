/**
 * チャットで推理の解答の受け口（issue #377）
 *
 * EventSub の Webhook に届いたチャンネルポイントの交換のうち、HDAD が作った「解答」の報酬（worker/chat-deduction-rewards.ts）
 * の交換を受ける（振り分けは worker/chat-deduction-question.ts の handleChatDeductionRedemption）。流れは次のとおり。
 * 1. 交換のIDを鍵に解答の行を作る。開催中のゲームが無ければ受け付けなかったことにする（worker/chat-deduction-store.ts の reserveGuess）。
 *    行がもうあれば再送なので何もしない（二重に照合しない）
 * 2. Twitch へ2xxを返したあとで（waitUntil）、問題集の別名と照合する（src/chat-deduction/guess.ts。LLM は使わない）。
 *    正解なら正解者を1人に決めてゲームを終え（solveGame）、2つの報酬を交換できないようにする。不正解なら記録する
 * 3. 正解・不正解の交換は FULFILLED、受け付けなかった交換（開催中でない・照合までにゲームが終わった）は CANCELED にしてポイントを返す。
 *    正誤を決めた解答はカードになるので、照合のすぐあとに合成ページへカードの一覧を押し出す（issue #378。worker/chat-deduction-board.ts）
 *
 * 注意: 終了の経路（配信者の打ち切り）と違い、ここではゲームを先に終えてから報酬を交換できないようにする。正解者は通知が届いた
 *   順に決まるので、報酬の切り替えの成否で正解を取り消さないためである。切り替えに失敗したら収集の失敗として残し、交換の更新は続ける
 *   （終えたあとに届いた解答と質問は、開催中でないとしてポイントを返すので、視聴者のポイントは消えない）。
 */
import { isCorrectChatDeductionGuess } from '../src/chat-deduction/guess'
import { CHAT_DEDUCTION_PROBLEMS } from '../src/chat-deduction/problem-set'
import { recordLateFailure } from './alert-actions'
import { pushBoardAfterRedemption } from './chat-deduction-board'
import { setChatDeductionRewardsEnabled, type ChatDeductionRewards } from './chat-deduction-rewards'
import { markGuessWrong, readGame, reserveGuess, solveGame, type ChatDeductionGuess } from './chat-deduction-store'
import { HttpError, STATUS, type Context } from './http'
import { getManageToken } from './reward-routes'
import { recordFailure } from './stats-store'
import type { RedemptionStatus } from './twitch'

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * 「解答」の交換の通知から、解答の行に書く項目を読む。
 *
 * @throws HttpError 交換のID・視聴者・解答の文字列が揃っていない場合（400。黙って捨てない）
 */
const readGuessRedemption = (event: Record<string, unknown>) => {
  const { id, user_id: userId, user_login: userLogin, user_name: userName, user_input: guess } = event
  if (typeof id !== 'string' || typeof userId !== 'string' || typeof userLogin !== 'string' || typeof userName !== 'string' || typeof guess !== 'string') {
    throw new HttpError(STATUS.badRequest, 'invalid-webhook', 'チャットで推理の解答の交換の通知に id・user_id・user_login・user_name・user_input が揃っていません')
  }
  return { redemptionId: id, userId, userLogin, userName, guess }
}

/**
 * 照合待ちの解答を問題の別名と照らし、正解ならゲームを終える。
 *
 * @returns 交換をどの状態にするかと、この解答でゲームを終えたか
 * @throws 解答を受けたゲームの問題が問題集に無い場合（問題集から消した問題のゲームが開催中だった）
 */
const judge = async (context: Context, guess: ChatDeductionGuess): Promise<{ status: RedemptionStatus; solved: boolean }> => {
  const { env, now } = context
  if (guess.status !== 'pending') return { status: 'CANCELED', solved: false }
  const game = guess.gameId === null ? null : await readGame(env.DB, guess.gameId)
  const problem = CHAT_DEDUCTION_PROBLEMS.find((candidate) => candidate.id === game?.problemId)
  if (problem === undefined) throw new Error(`解答を受けたゲーム（${String(guess.gameId)}）の問題が問題集にありません`)

  if (!isCorrectChatDeductionGuess(problem, guess.guess)) {
    await markGuessWrong(env.DB, guess.id, now)
    return { status: 'FULFILLED', solved: false }
  }
  // 照合するまでにほかの人の正解か打ち切りでゲームが終わっていたら、正解にならずポイントを返す
  const settled = await solveGame(env.DB, guess.id, now)
  return settled.status === 'correct' ? { status: 'FULFILLED', solved: true } : { status: 'CANCELED', solved: false }
}

/** 解答を照合し、正解ならゲームを終えて報酬を交換できないようにする。そのうえで交換を完了か取り消しにする */
const settle = async (context: Context, rewards: ChatDeductionRewards, guess: ChatDeductionGuess): Promise<void> => {
  const { env, twitch, now } = context
  // 正誤はトークンの有無にかかわらず決める（トークンが古いだけで正解者が出なかったことにしない）
  const { status, solved } = await judge(context, guess)
  // 正誤を決めた解答だけがカードになる（受け付けなかった解答では、映すものが変わらない）
  if (status === 'FULFILLED') await pushBoardAfterRedemption(context, `${guess.userName}さんの解答「${guess.guess}」の正誤`)
  /** 正解でゲームを終えたのに報酬を止められなかったことを、配信者が /rewards/ で直せるよう残す */
  const recordRewardsFailure = (error: unknown) =>
    recordFailure(env.DB, 'chat-deduction-rewards-failed', `${guess.userName}さんの正解でゲームを終えましたが、報酬を交換できないようにできませんでした。/rewards/ で確かめてください: ${reasonOf(error)}`, now)
  const { accessToken } = await getManageToken(context).catch(async (error: unknown) => {
    // トークンを取れなければ報酬も止められないので、そのことも残してから投げ直す（交換を更新できなかったことは呼び出し側が残す）
    if (solved) await recordRewardsFailure(error)
    throw error
  })
  if (solved) await setChatDeductionRewardsEnabled(twitch, accessToken, env.TWITCH_BROADCASTER_ID, rewards, false).catch(recordRewardsFailure)
  await twitch.updateRedemptionStatus(accessToken, env.TWITCH_BROADCASTER_ID, rewards.answerRewardId, guess.redemptionId, status)
}

/**
 * 「解答」の報酬の交換を受ける。
 *
 * @param event 自分のチャンネルの「解答」の報酬の交換と確かめた通知の中身
 * @throws HttpError 交換に必要な項目が揃っていない場合（400）
 */
export const receiveChatDeductionGuess = async (context: Context, rewards: ChatDeductionRewards, event: Record<string, unknown>): Promise<void> => {
  const guess = await reserveGuess(context.env.DB, readGuessRedemption(event), context.now)
  // 行がもうある（同じ通知の再送）なら、最初に届いたときに照合している
  if (guess === null) return
  context.waitUntil(recordLateFailure(context, 'chat-deduction-redemption-failed', () => settle(context, rewards, guess)))
}
