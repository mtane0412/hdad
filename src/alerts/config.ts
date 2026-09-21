/**
 * 設定の取得
 *
 * トリガーの一覧（どのイベントで、どの素材を、どう出すか）は、配信者が管理用APIで保存したものをWorker（/api/overlay/config）から受け取る。
 * 素材のURLにはWorkerがオーバーレイ用キーを付けて返すので、オーバーレイはそのまま img・video・audio に渡せばよい。
 * fetch を引数で受け取るのは、テストで差し替えるため。
 *
 * 注意: 応答が想定した形でなければエラーにする。黙って空の設定にすると、アラートが出ない原因に気付けない。
 */
import { readErrorMessage } from './subscribe'
import type { AlertMedia, AlertTrigger } from './trigger'

const CONFIG_PATH = '/api/overlay/config'
const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
const MEDIA_KINDS: readonly AlertMedia['kind'][] = ['image', 'video', 'audio']

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isMedia = (value: unknown): value is AlertMedia =>
  isRecord(value) && MEDIA_KINDS.some((kind) => kind === value.kind) && typeof value.url === 'string'

const isTrigger = (value: unknown): value is AlertTrigger =>
  isRecord(value) &&
  value.event === REDEMPTION &&
  (value.rewardId === null || typeof value.rewardId === 'string') &&
  isMedia(value.media) &&
  typeof value.durationSeconds === 'number' &&
  typeof value.volume === 'number' &&
  typeof value.message === 'string'

/**
 * Workerからトリガーの一覧を取得する。
 *
 * @param key オーバーレイ用キー
 * @throws Workerが失敗を返した場合（メッセージはWorkerのもの）、応答が想定した形でない場合
 */
export const fetchTriggers = async (key: string, fetchImpl: typeof fetch): Promise<AlertTrigger[]> => {
  const response = await fetchImpl(`${CONFIG_PATH}?key=${encodeURIComponent(key)}`)
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(readErrorMessage(body) ?? `アラートの設定を取得できませんでした（Workerが ${response.status} を返しました）`)

  if (!isRecord(body) || !Array.isArray(body.triggers)) throw new Error('アラートの設定の応答に triggers の配列がありません')
  return body.triggers.map((trigger: unknown, index) => {
    if (!isTrigger(trigger)) throw new Error(`アラートの設定の triggers[${index}] が想定した形ではありません`)
    return trigger
  })
}
