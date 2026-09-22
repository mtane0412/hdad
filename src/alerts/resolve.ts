/**
 * アラートの問い合わせ
 *
 * 届いた通知をそのままWorker（POST /api/overlay/alert）へ送り、再生するアラート（素材・表示時間・音量・文言）を受け取る。
 * 素材のURLにはWorkerがオーバーレイ用キーを付けて返すので、オーバーレイはそのまま img・video・audio に渡せばよい。
 *
 * 照合（どのトリガーに当てはまるか）と差し込み語の置き換えはWorkerが受け持つ。オーバーレイで判定しないのは、
 * 条件に「その配信で初めての発言か」のようにデータベースの記録から決まるものがあり、オーバーレイでは決められないためである。
 * 通知のたびに問い合わせるので、管理画面での変更はOBSの再読み込みなしで反映される。
 *
 * fetch を引数で受け取るのは、テストで差し替えるため。
 *
 * 注意: 応答が想定した形でなければエラーにする。黙って「当てはまらなかった」ことにすると、アラートが出ない原因に気付けない。
 */
import type { EventSubNotification } from './eventsub'
import { readErrorMessage } from './subscribe'

const ALERT_PATH = '/api/overlay/alert'

/** 再生する素材。image は静止画・アニメーション画像、audio は音だけ */
export interface AlertMedia {
  readonly kind: 'image' | 'video' | 'audio'
  readonly url: string
}

const MEDIA_KINDS: readonly AlertMedia['kind'][] = ['image', 'video', 'audio']

/** 画面に出すアラート1件 */
export interface Alert {
  readonly media: AlertMedia
  /** 表示する秒数 */
  readonly durationSeconds: number
  /** 音量（0〜1）。動画と音声に使う */
  readonly volume: number
  /** 表示する文言。差し込み語はWorkerが置き換え済み。空文字なら文言を出さない */
  readonly text: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isMedia = (value: unknown): value is AlertMedia => isRecord(value) && MEDIA_KINDS.some((kind) => kind === value.kind) && typeof value.url === 'string'

const isAlert = (value: unknown): value is Alert =>
  isRecord(value) && isMedia(value.media) && typeof value.durationSeconds === 'number' && typeof value.volume === 'number' && typeof value.text === 'string'

/**
 * 通知をWorkerへ送り、再生するアラートを受け取る。
 *
 * @param key オーバーレイ用キー
 * @returns 再生するアラート。当てはまるトリガーがなければ null
 * @throws Workerが失敗を返した場合（メッセージはWorkerのもの）、応答が想定した形でない場合
 */
export const resolveAlert = async (key: string, notification: EventSubNotification, fetchImpl: typeof fetch): Promise<Alert | null> => {
  const response = await fetchImpl(`${ALERT_PATH}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscriptionType: notification.subscriptionType, event: notification.event }),
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(readErrorMessage(body) ?? `アラートを問い合わせられませんでした（Workerが ${response.status} を返しました）`)

  if (!isRecord(body) || !('alert' in body)) throw new Error('アラートの応答に alert がありません')
  if (body.alert === null) return null
  if (!isAlert(body.alert)) throw new Error('アラートの応答の alert が想定した形ではありません')
  return body.alert
}
