/**
 * 人形の獲得（Worker が押し出す、1回ぶんの「誰が・どの人形を・いくつ」）
 *
 * Worker（worker/doll-award.ts の grantDolls）が、トリガーの動作「人形を渡す」とゲームの正解者に人形を渡したときに、
 * 合成ページの素材「人形の獲得」へ WebSocket で押し出す。配信者が管理画面から手で増減させたものは押し出されない。
 *
 * 注意: 形が違えば黙って流さずに投げる（素材の箱に失敗を出す）。形は worker/doll-award.ts の DollAwardCall と合わせる。
 * 注意: 画像の URL は Worker の素材の経路（/api/media/<ID>?key=<オーバーレイ用キー>）だけを受け付ける。
 */
import { isRecord } from '../core/api'
import { isDollKind, type DollKind } from '../dolls/doll'

/** 1回の人形の獲得 */
export interface DollAwardCall {
  /** 獲得ごとの識別子 */
  readonly id: string
  /** 渡した視聴者の表示名 */
  readonly userName: string
  readonly kind: DollKind
  /** 渡した個数（1 以上の整数） */
  readonly count: number
  /** 渡した人形の名前と、画像を読む URL */
  readonly doll: { readonly name: string; readonly imageUrl: string }
}

/** 人形の画像として受け付ける URL の頭（Worker の素材の経路） */
const MEDIA_PATH_PREFIX = '/api/media/'

const readDoll = (value: unknown): DollAwardCall['doll'] | null => {
  if (!isRecord(value)) return null
  const { name, imageUrl } = value
  if (typeof name !== 'string' || name === '') return null
  if (typeof imageUrl !== 'string' || !imageUrl.startsWith(MEDIA_PATH_PREFIX)) return null
  return { name, imageUrl }
}

/**
 * WebSocket で押し出された文字列を、人形の獲得として読む。
 *
 * @throws JSONとして読めない・想定した形でない場合
 */
export const parseDollAwardCall = (payload: string): DollAwardCall => {
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    throw new Error('押し出された人形の獲得をJSONとして読めません')
  }
  const invalid = new Error('押し出された人形の獲得が想定した形ではありません')
  if (!isRecord(body)) throw invalid
  const { id, userName, kind, count, doll: dollValue } = body
  if (typeof id !== 'string' || typeof userName !== 'string' || userName === '') throw invalid
  if (!isDollKind(kind)) throw invalid
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) throw invalid
  const doll = readDoll(dollValue)
  if (doll === null) throw invalid
  return { id, userName, kind, count, doll }
}
