/**
 * 認可を待つ間の問い合わせの間隔
 *
 * デバイスコードフローでは、利用者が別の端末で認可を済ませるまで、Worker へ繰り返し問い合わせる。
 * その間隔の決め方だけを、画面（bot-page.tsx）から分けてここに置く。
 *
 * 注意: Twitch が slow_down を返したら、RFC 8628 は「以降の問い合わせの間隔を5秒延ばす」ことを求めている。
 * 延ばさずに問い合わせ続けると、また slow_down を返されて認可がいつまでも済まない。
 */
import type { DevicePoll } from './api'

/** slow_down を受け取るたびに延ばす秒数（RFC 8628 の決まった値） */
const SLOW_DOWN_STEP_SECONDS = 5

/**
 * 次に問い合わせるまで空ける秒数。
 *
 * @param currentSeconds いま使っている間隔（最初は Twitch が発行時に指定した値）
 * @param result 直前の問い合わせの結果
 */
export const nextIntervalSeconds = (currentSeconds: number, result: DevicePoll): number =>
  result.status === 'slow-down' ? currentSeconds + SLOW_DOWN_STEP_SECONDS : currentSeconds
