/**
 * 届いたアラートの読み取り
 *
 * Workerが「どのトリガーに当てはまるか」を決め、再生するアラート（素材・表示時間・音量・置き換え済みの文言）を
 * WebSocketで押し出してくる（worker/alert-channel.ts）。オーバーレイはそれを受け取って再生するだけでよい。
 * 素材のURLにはWorkerがオーバーレイ用キーを付けているので、そのまま img・video・audio に渡せる。
 *
 * 注意: 想定した形でなければエラーにする。黙って捨てると、アラートが出ない原因に気付けない。
 */

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
 * 押し出されてきた1件分のアラートを読み取る。
 *
 * @param payload WebSocketで届いた文字列
 * @throws JSONとして読めない場合、想定した形でない場合
 */
export const parseAlert = (payload: string): Alert => {
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    throw new Error('届いたアラートをJSONとして読めません')
  }
  if (!isAlert(value)) throw new Error('届いたアラートが想定した形ではありません')
  return value
}
