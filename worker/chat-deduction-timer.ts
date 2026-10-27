/**
 * チャットで推理の制限時間の締め切り（Durable Object の中でアラームを持つ）
 *
 * Worker はタイマーを持てないので、制限時間を設定してゲームを始めたら締め切りの時刻を Durable Object へ預け
 * （scheduleChatDeductionTimeout。worker/chat-deduction-start.ts が呼ぶ）、時刻が来たらアラームで起こしてもらう。
 * 締め切りにそのゲームがまだ開催中なら、時間切れ（timeout）で終え、「質問」「解答」の2つの報酬を交換できないようにし
 * （トリガーのチャンネルポイントで始めたゲームなら、始めた報酬を交換できるように戻す）、合成ページへカードの一覧を押し出す。
 *
 * 預け先は広告の終了のタイマーと同じクラス（worker/ad-break-timer.ts の AdBreakTimer）の別のインスタンス（名前 chat-deduction）である。
 * 新しい Durable Object のクラスを足すと PR のプレビューのビルドが失敗するためで、ポモドーロ・漢字クイズ・意見ボードと同じ形にする。
 * 開催中のゲームは1つだけなので、預かる締め切りも1つだけにする（次のゲームの締め切りで上書きする）。
 *
 * Durable Object は時計であって判定者ではない（.claude/rules/implementation.md）。ゲームが開催中かは、鳴ったときに D1 を読んで決める
 * （締め切りまでに正解・打ち切りで終えていれば何もしない。終える文も開催中の行だけを書き換えるので、正解と時間切れは一方しか通らない）。
 *
 * 注意: 解答の経路（worker/chat-deduction-guess.ts）と同じく、ゲームを先に終えてから報酬を交換できないようにする。
 *   時間切れを報酬の切り替えの成否で取り消さないためで、終えたあとに届いた質問・解答は開催中でないとしてポイントを返す。
 * 注意: 鳴ったら、預かった締め切りを消してから実行する。実行が失敗したときにアラームの再試行で同じ終了を二度試みないためである。
 *   失敗は投げずに記録する（報酬の切り替えは chat-deduction-rewards-failed、合成ページへの押し出しは chat-deduction-push-failed、
 *   その手前の D1 などは chat-deduction-timeout-failed）。
 */
import { CHAT_DEDUCTION_IMAGES, CHAT_DEDUCTION_PROBLEM_SETS } from '../src/chat-deduction/problem-set'
import type { AlarmDependencies } from './alarm-actions'
import { pushLatestChatDeductionBoard } from './chat-deduction-board'
import { loadChatDeductionRewards, setChatDeductionRewardsEnabled } from './chat-deduction-rewards'
import { endGame, readGameStartReward } from './chat-deduction-store'
import { STATUS, type Env } from './http'
import { getManageToken } from './reward-routes'
import { recordFailure } from './stats-store'
import { createTwitchClient } from './twitch'

/** Durable Object の名前。広告の終了・ポモドーロ・漢字クイズ・意見ボードとアラームを取り合わないよう、別のインスタンスを指す */
const TIMER_NAME = 'chat-deduction'
/** Worker が締め切りを預けるパス。外には出ない */
const SCHEDULE_PATH = '/chat-deduction/schedule'
/** 預かった締め切りを storage に持つときの鍵（この鍵があるインスタンスだけが、チャットで推理のアラームを持つ） */
const TIMEOUT_KEY = 'chat-deduction-timeout'

/** 預かる締め切り1つ */
export interface ChatDeductionTimeout {
  readonly gameId: number
  /** 締め切りの時刻（ミリ秒） */
  readonly closesAt: number
}

/** Durable Object から使う保管の仕組み（worker/ad-break-timer.ts の AdBreakTimerState の storage と同じもの） */
export interface ChatDeductionTimerStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  setAlarm(scheduledTime: number): Promise<void>
}

/** Worker が Durable Object を呼ぶための入口（worker/ad-break-timer.ts の AdBreakTimerNamespace と同じ形） */
interface ChatDeductionTimerNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> }
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * ゲームの締め切りを Durable Object へ預ける。制限時間を設定してゲームを始めたときに呼ぶ。
 *
 * @throws 預けられなかった場合（呼び出し側がゲームを始めなかったことにする。時間切れにならないまま始めない）
 */
export const scheduleChatDeductionTimeout = async (namespace: ChatDeductionTimerNamespace, timeout: ChatDeductionTimeout): Promise<void> => {
  const response = await namespace
    .get(namespace.idFromName(TIMER_NAME))
    .fetch(new Request(`https://ad-break-timer${SCHEDULE_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(timeout) }))
  if (!response.ok) throw new Error(`チャットで推理の制限時間の締め切りを予約できませんでした（${response.status}）`)
}

/**
 * Durable Object に届いた要求のうち、チャットで推理の締め切りの予約を受け付ける。
 *
 * @returns チャットで推理の要求でなければ null（ほかの振り分けへ回す）
 */
export const handleChatDeductionTimerRequest = async (storage: ChatDeductionTimerStorage, request: Request): Promise<Response | null> => {
  if (new URL(request.url).pathname !== SCHEDULE_PATH) return null
  const body: unknown = await request.json()
  const { gameId, closesAt }: Record<string, unknown> = typeof body === 'object' && body !== null ? { ...body } : {}
  if (typeof gameId !== 'number' || typeof closesAt !== 'number') return new Response(null, { status: STATUS.badRequest })
  // 開催中のゲームは1つだけなので、残っていた締め切り（もう終えたゲームのもの）は上書きしてよい
  await storage.put(TIMEOUT_KEY, { gameId, closesAt } satisfies ChatDeductionTimeout)
  await storage.setAlarm(closesAt)
  return new Response(null, { status: STATUS.noContent })
}

/**
 * 開催中のゲームを時間切れで終え、報酬を交換できないようにして、合成ページへ押し出す。もう終えていれば何もしない。
 *
 * @throws D1 を読み書きできなかった場合（報酬の切り替えと押し出しの失敗は投げずに記録する）
 */
const timeOutGame = async (env: Env, dependencies: Pick<AlarmDependencies, 'fetch'>, gameId: number, now: number): Promise<void> => {
  const game = await endGame(env.DB, gameId, 'timeout', now)
  // 締め切りまでに正解・打ち切りで終えていた
  if (game === null) return

  /** 時間切れで終えたのに報酬を止められなかったことを、配信者が /rewards/ で直せるよう残す */
  const recordRewardsFailure = (error: unknown) =>
    recordFailure(env.DB, 'chat-deduction-rewards-failed', `制限時間が尽きたのでゲームを終えましたが、報酬を交換できないようにできませんでした。/rewards/ で確かめてください: ${reasonOf(error)}`, now)
  const twitch = createTwitchClient({ clientId: env.TWITCH_CLIENT_ID, clientSecret: env.TWITCH_CLIENT_SECRET, fetch: dependencies.fetch })
  const rewards = await loadChatDeductionRewards(env.STORE)
  if (rewards === null) await recordRewardsFailure(new Error('チャットで推理の報酬のIDが控えられていません'))
  else {
    const startRewardId = await readGameStartReward(env.DB, gameId)
    await getManageToken({ env, twitch, now })
      .then(({ accessToken }) => setChatDeductionRewardsEnabled(twitch, accessToken, env.TWITCH_BROADCASTER_ID, rewards, false, startRewardId))
      .catch(recordRewardsFailure)
  }
  await pushLatestChatDeductionBoard(env.DB, env.STORE, env.ALERTS, CHAT_DEDUCTION_PROBLEM_SETS, CHAT_DEDUCTION_IMAGES).catch((error: unknown) =>
    recordFailure(env.DB, 'chat-deduction-push-failed', `制限時間が尽きてゲームを終えたことを合成ページへ知らせられませんでした: ${reasonOf(error)}`, now),
  )
}

/**
 * アラームが鳴ったときに、預かった締め切りのゲームを時間切れで終える。
 *
 * @returns このインスタンスがチャットで推理の締め切りを預かっていたか（預かっていなければほかの振り分けへ回す）
 */
export const runChatDeductionAlarm = async (storage: ChatDeductionTimerStorage, env: Env, dependencies: Pick<AlarmDependencies, 'fetch' | 'now'>): Promise<boolean> => {
  const timeout = await storage.get<ChatDeductionTimeout>(TIMEOUT_KEY)
  if (timeout === undefined) return false

  const now = dependencies.now()
  // 消してから実行する。失敗しても再試行で同じ終了を試みないため
  await storage.delete(TIMEOUT_KEY)
  try {
    await timeOutGame(env, dependencies, timeout.gameId, now)
  } catch (error) {
    await recordFailure(env.DB, 'chat-deduction-timeout-failed', `チャットで推理のゲーム（${timeout.gameId}）を時間切れで終えられませんでした: ${reasonOf(error)}`, now)
  }
  return true
}
