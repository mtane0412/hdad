/**
 * 市町村紹介の呼び出しと紹介の形（合成ページの素材「市町村紹介」が受け取るもの）
 *
 * 素材は2つのものを Worker から受け取る。
 * - 呼び出し: トリガー（レイド・キーワード）や試し再生で、AlertChannel から WebSocket で押し出される。市町村と冒頭の一文だけを持つ
 *   （worker/town-tour-call.ts の TownTourCall と同じ形）
 * - 紹介: 呼び出しを受け取ってから GET /api/overlay/town-tour?code= で作らせる。記事名・出典の URL・5項目を持つ
 *   （worker/town-tour-routes.ts の応答と同じ形）
 *
 * 注意: どちらも想定した形でなければ補わずに投げる（Fail-Fast）。出典が欠けた紹介は Wikipedia の文を出典なしで流すことになるので、
 * 特に通さない。
 */
import { isRecord } from '../core/api'

/** 紹介の項目。並び順は画面に流す順で、worker/town-tour.ts の TOWN_TOUR_ITEMS と同じ */
export const TOUR_ITEMS = ['location', 'nameOrigin', 'history', 'specialty', 'surprise'] as const

export type TourItem = (typeof TOUR_ITEMS)[number]

/** 項目ごとに画面に出す見出し */
const TOUR_ITEM_LABELS: Readonly<Record<TourItem, string>> = {
  location: 'どこにある？',
  nameOrigin: '名前の由来',
  history: '歴史',
  specialty: '名物',
  surprise: '意外な一面',
}

/** 押し出された呼び出し。市町村（コードは全国地方公共団体コードの5桁）と、冒頭に出す一文 */
export interface TownTourCall {
  readonly code: string
  readonly prefecture: string
  /** 郡（町村だけが持つ。市と区は空文字） */
  readonly county: string
  readonly name: string
  readonly headline: string
}

/** 作らせた紹介。材料に無かった項目は空文字になる */
export interface TownTourIntro {
  /** 出典の記事（Wikipedia の本文は CC BY-SA なので、記事名と URL を画面に出す） */
  readonly article: { readonly title: string; readonly url: string }
  readonly tour: Readonly<Record<TourItem, string>>
}

/** 画面に流す1項目 */
export interface TourLine {
  readonly label: string
  readonly text: string
}

const isTownTourCall = (value: unknown): value is TownTourCall =>
  isRecord(value) &&
  typeof value.code === 'string' &&
  typeof value.prefecture === 'string' &&
  typeof value.county === 'string' &&
  typeof value.name === 'string' &&
  typeof value.headline === 'string'

/**
 * WebSocket で押し出された文字列を、市町村紹介の呼び出しとして読む。
 *
 * @throws JSONとして読めない・想定した形でない場合
 */
export const parseTownTourCall = (payload: string): TownTourCall => {
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    throw new Error('押し出された市町村紹介をJSONとして読めません')
  }
  if (!isTownTourCall(body)) throw new Error('押し出された市町村紹介が想定した形ではありません')
  const { code, prefecture, county, name, headline } = body
  return { code, prefecture, county, name, headline }
}

/**
 * Worker の応答（GET /api/overlay/town-tour）を、紹介として読む。
 *
 * @throws 出典（記事名・URL）か5項目のどれかが欠けている場合
 */
export const readTownTourIntro = (body: unknown): TownTourIntro => {
  const article: unknown = isRecord(body) ? body.article : undefined
  if (!isRecord(article) || typeof article.title !== 'string' || typeof article.url !== 'string') {
    throw new Error('Workerの応答に、紹介の出典（記事名と URL）がありません')
  }
  const tour: unknown = isRecord(body) ? body.tour : undefined
  const itemOf = (item: TourItem): string => {
    const text = isRecord(tour) ? tour[item] : undefined
    if (typeof text !== 'string') throw new Error(`Workerの応答の紹介に、項目 ${item} がありません`)
    return text
  }
  return {
    article: { title: article.title, url: article.url },
    tour: {
      location: itemOf('location'),
      nameOrigin: itemOf('nameOrigin'),
      history: itemOf('history'),
      specialty: itemOf('specialty'),
      surprise: itemOf('surprise'),
    },
  }
}

/** 紹介から、画面に流す項目を決まった順に並べる。材料に無かった（空の）項目は飛ばす */
export const tourItemsOf = (tour: TownTourIntro['tour']): TourLine[] =>
  TOUR_ITEMS.filter((item) => tour[item] !== '').map((item) => ({ label: TOUR_ITEM_LABELS[item], text: tour[item] }))
