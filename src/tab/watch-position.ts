/**
 * 同時視聴の再生位置（issue #443）
 *
 * Prime Video では映像と音を送らず、再生位置と作品の題名・画像だけを拡張から合成ページへ送る。
 * 視聴者は配信画面の時刻に合わせて、自分の環境で同じ作品を再生する。ここは送る値の形の検証と、合成ページに出す時刻の計算だけを持つ。
 *
 * 時刻は配信の映像に焼き込まれ、配信者の声と同じだけ遅れて視聴者へ届くので、配信の遅延は補正しない。
 *
 * 注意: 画像は配信画面にそのまま出るので、Amazon の画像の置き場所だけを受け入れる。
 * 注意: 拡張の offscreen document と合成ページが読み込む。サービスワーカーからは型だけを使う（共有のチャンクを作らないため）。
 */
import { isRecord } from '../core/api'

/** 拡張から合成ページへ送る、ある時点の再生の状態 */
export interface WatchPosition {
  /** 読み取った時点の再生位置（秒） */
  readonly positionSeconds: number
  /** 再生中か（false なら時刻を進めない） */
  readonly playing: boolean
  /** 再生速度 */
  readonly rate: number
  /** 作品の題名（読めなければ null） */
  readonly title: string | null
  /** 作品の画像の URL（読めなければ null） */
  readonly imageUrl: string | null
}

const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const MILLISECONDS_PER_SECOND = 1000
/** 実機の Prime Video で作品の画像が置かれていたホストの末尾 */
const IMAGE_HOST_SUFFIXES = ['.media-amazon.com', '.ssl-images-amazon.com']

const INVALID = '再生位置の形が想定と違います'

const isAllowedImageUrl = (value: string): boolean => {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === 'https:' && IMAGE_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix))
}

const isNonNegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/**
 * 届いた値を再生位置として読む。
 *
 * @throws 形が違う場合と、画像の置き場所が Amazon でない場合
 */
export const parseWatchPosition = (value: unknown): WatchPosition => {
  if (!isRecord(value) || !isNonNegative(value.positionSeconds) || typeof value.playing !== 'boolean' || !isNonNegative(value.rate)) throw new Error(INVALID)
  const { title, imageUrl } = value
  if ((title !== null && typeof title !== 'string') || (imageUrl !== null && typeof imageUrl !== 'string')) throw new Error(INVALID)
  if (imageUrl !== null && !isAllowedImageUrl(imageUrl)) throw new Error('作品の画像の置き場所が想定と違います')
  return { positionSeconds: value.positionSeconds, playing: value.playing, rate: value.rate, title, imageUrl }
}

/** 受け取ってから elapsedMilliseconds たった時点の再生位置（秒）を求める */
export const displayedSeconds = (position: WatchPosition, elapsedMilliseconds: number): number =>
  position.playing ? position.positionSeconds + (position.rate * elapsedMilliseconds) / MILLISECONDS_PER_SECOND : position.positionSeconds

/** 秒を Prime Video の画面と同じ「時:分:秒」にする（実機で currentTime 33.9 秒が 0:00:34 と出たので四捨五入する） */
export const formatWatchTime = (seconds: number): string => {
  const total = Math.round(seconds)
  const hours = Math.floor(total / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR))
  const minutes = Math.floor(total / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR
  const rest = total % SECONDS_PER_MINUTE
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}
