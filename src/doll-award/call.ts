/**
 * 人形の獲得の素材に届くもの（Worker が押し出す、獲得・1人ぶんの所持数・ランキング）
 *
 * Worker が合成ページの素材「人形の獲得」へ WebSocket で押し出すものを読む。type で3つを見分ける。
 * - award: トリガーの動作「人形を渡す」とゲームの正解者に人形を渡したときの「誰が・どの人形を・いくつ」（worker/doll-award.ts の grantDolls）。
 *   配信者が管理画面から手で増減させたものは押し出されない
 * - standing: 1人ぶんのいまの人形の所持数（チャットの !人形 と /viewers/ から。worker/doll-standing.ts）
 * - ranking: いまの人形の点数のランキング（チャットの !人形ランキング と /dolls/ から。worker/doll-standing.ts）
 *
 * 注意: 形が違えば黙って流さずに投げる（素材の箱に失敗を出す）。形は worker/doll-award.ts の DollAwardMessage と合わせる。
 * 注意: 画像の URL は Worker の素材の経路（/api/media/<ID>?key=<オーバーレイ用キー>）だけを受け付ける。
 */
import { isRecord } from '../core/api'
import { isDollKind, type DollKind } from '../dolls/doll'

/** 人形1種類ぶんの名前と、画像を読む URL */
export interface DollFigureView {
  readonly name: string
  readonly imageUrl: string
}

/** 1回の人形の獲得 */
export interface DollAwardCall {
  readonly type: 'award'
  /** 獲得ごとの識別子 */
  readonly id: string
  /** 渡した視聴者の表示名 */
  readonly userName: string
  readonly kind: DollKind
  /** 渡した個数（1 以上の整数） */
  readonly count: number
  /** 渡した人形の名前と画像 */
  readonly doll: DollFigureView
}

/** 1人ぶんの、いまの人形の所持数 */
export interface DollStandingCall {
  readonly type: 'standing'
  /** 表示ごとの識別子 */
  readonly id: string
  /** 視聴者の表示名 */
  readonly userName: string
  /** いまの人形の種類ごとの名前・画像と、持っている数（0 以上の整数） */
  readonly normal: DollFigureView & { readonly count: number }
  readonly super: DollFigureView & { readonly count: number }
}

/** ランキングの1人ぶん */
export interface DollRankingEntry {
  /** 順位（1 以上。同点は同じ順位） */
  readonly rank: number
  readonly userName: string
  readonly normal: number
  readonly super: number
  /** 点数（ふつう＝1・スーパー＝3） */
  readonly points: number
}

/** いまの人形の点数のランキング */
export interface DollRankingCall {
  readonly type: 'ranking'
  /** 表示ごとの識別子 */
  readonly id: string
  /** いまの人形の種類ごとの名前と画像 */
  readonly normal: DollFigureView
  readonly super: DollFigureView
  /** 点数の高い順。0 人のこともある */
  readonly entries: readonly DollRankingEntry[]
}

/** 素材「人形の獲得」に届くもの */
export type DollAwardMessage = DollAwardCall | DollStandingCall | DollRankingCall

/** 人形の画像として受け付ける URL の頭（Worker の素材の経路） */
const MEDIA_PATH_PREFIX = '/api/media/'

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== ''

/** 下限以上の整数か */
const isIntegerAtLeast = (value: unknown, min: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min

const readFigure = (value: unknown): DollFigureView | null => {
  if (!isRecord(value)) return null
  const { name, imageUrl } = value
  if (!isNonEmptyString(name)) return null
  if (typeof imageUrl !== 'string' || !imageUrl.startsWith(MEDIA_PATH_PREFIX)) return null
  return { name, imageUrl }
}

/** 所持数つきの人形1種類を読む（0 つも受け付ける） */
const readHeldFigure = (value: unknown): (DollFigureView & { count: number }) | null => {
  const figure = readFigure(value)
  if (figure === null || !isRecord(value) || !isIntegerAtLeast(value.count, 0)) return null
  return { ...figure, count: value.count }
}

const readRankingEntry = (value: unknown): DollRankingEntry | null => {
  if (!isRecord(value)) return null
  const { rank, userName, normal, super: superCount, points } = value
  if (!isIntegerAtLeast(rank, 1) || !isNonEmptyString(userName)) return null
  if (!isIntegerAtLeast(normal, 0) || !isIntegerAtLeast(superCount, 0) || !isIntegerAtLeast(points, 1)) return null
  return { rank, userName, normal, super: superCount, points }
}

/** type ごとに中身を読む。形が違えば null */
const readMessage = (body: Record<string, unknown>): DollAwardMessage | null => {
  const { type, id } = body
  if (typeof id !== 'string') return null
  switch (type) {
    case 'award': {
      const { userName, kind, count } = body
      const doll = readFigure(body.doll)
      if (!isNonEmptyString(userName) || !isDollKind(kind) || !isIntegerAtLeast(count, 1) || doll === null) return null
      return { type, id, userName, kind, count, doll }
    }
    case 'standing': {
      const { userName } = body
      const normal = readHeldFigure(body.normal)
      const superFigure = readHeldFigure(body.super)
      if (!isNonEmptyString(userName) || normal === null || superFigure === null) return null
      return { type, id, userName, normal, super: superFigure }
    }
    case 'ranking': {
      const normal = readFigure(body.normal)
      const superFigure = readFigure(body.super)
      if (normal === null || superFigure === null || !Array.isArray(body.entries)) return null
      const entries = body.entries.map(readRankingEntry)
      if (entries.some((entry) => entry === null)) return null
      return { type, id, normal, super: superFigure, entries: entries.filter((entry) => entry !== null) }
    }
    default:
      return null
  }
}

/**
 * WebSocket で押し出された文字列を、素材「人形の獲得」に届いたものとして読む。
 *
 * @throws JSONとして読めない・想定した形でない場合
 */
export const parseDollAwardMessage = (payload: string): DollAwardMessage => {
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    throw new Error('押し出された人形の獲得をJSONとして読めません')
  }
  const message = isRecord(body) ? readMessage(body) : null
  if (message === null) throw new Error('押し出された人形の獲得が想定した形ではありません')
  return message
}
