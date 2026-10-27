/**
 * チャットで推理の制限時間
 *
 * ゲームを始めてから、正解者が出ないまま何分たったら Worker がゲームを時間切れで終えるかを、「なし」か決まった分数で持つ。
 * 設定はチャットで推理として1つだけで（worker/chat-deduction-time-limit.ts。KV）、ページから始めてもトリガーで始めても同じ時間を使う。
 * 始めたときの設定から締め切りの時刻を決めてゲームの行に控えるので、開催中に設定を変えても、そのゲームの締め切りは変わらない。
 * 未保存なら「なし」（制限時間を設定にする前と同じく、配信者が終えるか正解者が出るまで続ける）。
 *
 * 注意: Worker（保存時の検証と締め切りの計算）とアプリのページ（選択肢と応答の読み取り）と合成ページ（残り時間の書き方）が
 * 同じものを読む。Worker から src/ を読み込む例外の1つで、判定を2か所に書き分けないためである（.claude/rules/chat-deduction.md）。
 */

/** 選べる制限時間（分）。小さい順。質問の上限（30件）を使い切るのに十分な長さまでにする */
export const CHAT_DEDUCTION_TIME_LIMIT_MINUTES: readonly number[] = [5, 10, 15, 20, 30]

/** 1分のミリ秒 */
const MINUTE_MS = 60_000
/** 1秒のミリ秒 */
const SECOND_MS = 1_000
/** 1分の秒数 */
const SECONDS_PER_MINUTE = 60

/** 制限時間の設定 */
export interface ChatDeductionTimeLimit {
  /** 制限時間（分）。なしなら null */
  readonly minutes: number | null
}

/** 値が制限時間として選べるもの（なしの null か、CHAT_DEDUCTION_TIME_LIMIT_MINUTES のどれか）か */
export const isChatDeductionTimeLimitMinutes = (value: unknown): value is number | null =>
  value === null || CHAT_DEDUCTION_TIME_LIMIT_MINUTES.some((minutes) => minutes === value)

/**
 * Worker から返ってきた設定を読む（アプリのページ）。
 *
 * @throws 分数が選べるものでない・形が違う場合
 */
export const readChatDeductionTimeLimit = (body: unknown): ChatDeductionTimeLimit => {
  const minutes = typeof body === 'object' && body !== null && 'minutes' in body ? body.minutes : undefined
  if (!isChatDeductionTimeLimitMinutes(minutes)) throw new Error(`チャットで推理の制限時間は なし か ${CHAT_DEDUCTION_TIME_LIMIT_MINUTES.join('・')}分 のはずです`)
  return { minutes }
}

/**
 * 始めた時刻と制限時間から、締め切りの時刻（ミリ秒）を決める。
 *
 * @returns 締め切りの時刻。制限時間がなしなら null
 */
export const chatDeductionClosesAtOf = (minutes: number | null, startedAt: number): number | null => (minutes === null ? null : startedAt + minutes * MINUTE_MS)

/**
 * 締め切りまでの残りを「分:秒」（例: 4:32）で書く（合成ページの見出しの帯）。
 *
 * 1秒に満たない端数は切り上げ、0:00 は締め切りを過ぎてから出す。過ぎていれば負にせず 0:00 にする。
 *
 * @param remainingMs 締め切りまでのミリ秒
 */
export const formatChatDeductionRemaining = (remainingMs: number): string => {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / SECOND_MS))
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE)
  const seconds = totalSeconds % SECONDS_PER_MINUTE
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
