/**
 * 市町村紹介の呼び出しと紹介の形（合成ページの素材「市町村紹介」が受け取るもの）
 *
 * 素材は2つのものを Worker から受け取る。
 * - 呼び出し: トリガー（レイド・キーワード）や試し再生で、AlertChannel から WebSocket で押し出される。市町村と冒頭の一文と、
 *   演出で鳴らす音（sound.ts）と、着地で大きさの文（scale.ts）にする人口・面積・いま見ている人数を持つ
 *   （worker/town-tour-call.ts の TownTourCall と同じ形）
 * - 紹介: 呼び出しを受け取ってから GET /api/overlay/town-tour?code= で作らせる。記事名・出典の URL と、大見出し・項目・配信者への振りを持つ
 *   （worker/town-tour-routes.ts の応答と同じ形）
 *
 * 注意: どちらも想定した形でなければ補わずに投げる（Fail-Fast）。出典が欠けた紹介は Wikipedia の文を出典なしで流すことになるので、
 * 特に通さない。
 */
import { isRecord } from '../core/api'
import type { TownTourAudience } from './scale'
import { readPlaybackSound, type TownTourPlaybackSound } from './sound'

/** 大見出しの場面に添える見出し。「この町、実は…」の「町」は市町村の名前の最後の字（市・町・村・区）にする */
const hookLabelOf = (townName: string): string => `この${townName.slice(-1)}、実は…`
/** 配信者への振りの場面に添える見出し */
const CUE_LABEL = 'ところで…'

/** 押し出された呼び出し。市町村（コードは全国地方公共団体コードの5桁）と、冒頭に出す一文と、鳴らす音 */
export interface TownTourCall {
  readonly code: string
  readonly prefecture: string
  /** 郡（町村だけが持つ。市と区は空文字） */
  readonly county: string
  readonly name: string
  readonly headline: string
  readonly sound: TownTourPlaybackSound
  /** 住民基本台帳の人口。記録が無い村（北方領土の6村）は null */
  readonly population: number | null
  /** 面積（km²） */
  readonly area: number
  /** 人口と比べる、いま見ている人数。分からない（配信中でない）ときは null */
  readonly audience: TownTourAudience | null
}

/** 大見出しを支える1項目（worker/town-tour.ts の TownTourPoint と同じ形） */
export interface TourPoint {
  readonly label: string
  readonly text: string
}

/** 作らせた紹介（worker/town-tour.ts の TownTour と同じ形） */
export interface TownTourIntro {
  /** 出典の記事（Wikipedia の本文は CC BY-SA なので、記事名と URL を画面に出す） */
  readonly article: { readonly title: string; readonly url: string }
  readonly tour: {
    /** 大見出し。材料が薄くて立てられなかった町は空文字 */
    readonly hook: string
    /** 大見出しを支える項目（1つ以上）。最後の項目がオチ */
    readonly points: readonly TourPoint[]
    /** 配信者への振り */
    readonly cue: string
  }
}

/** 画面に流す1場面。kind は場面の種類で、長さと描き方を決める（timeline.ts・view.ts） */
export interface TourLine {
  readonly kind: 'hook' | 'point' | 'cue'
  readonly label: string
  readonly text: string
}

/** 市町村と冒頭の一文の形だけを見る（音の設定は readPlaybackSound、人口と面積と見ている人数は readScale が理由つきで確かめる） */
const isTownTourCall = (value: unknown): value is Pick<TownTourCall, 'code' | 'prefecture' | 'county' | 'name' | 'headline'> & Record<string, unknown> =>
  isRecord(value) &&
  typeof value.code === 'string' &&
  typeof value.prefecture === 'string' &&
  typeof value.county === 'string' &&
  typeof value.name === 'string' &&
  typeof value.headline === 'string'

/** 見ている人数のきっかけ（レイドか、いまの同接か） */
const AUDIENCE_KINDS: readonly string[] = ['raid', 'live'] satisfies TownTourAudience['kind'][]

/** 見ている人数として読む（null は分からないことを表すのでそのまま通す） */
const readAudience = (value: unknown): TownTourAudience | null => {
  if (value === null) return null
  if (!isRecord(value) || typeof value.count !== 'number' || typeof value.kind !== 'string' || !AUDIENCE_KINDS.includes(value.kind)) {
    throw new Error('押し出された市町村紹介の見ている人数が想定した形ではありません')
  }
  return { kind: value.kind === 'raid' ? 'raid' : 'live', count: value.count }
}

/**
 * 人口・面積・見ている人数を読む
 *
 * @throws 人口が数でも null でもない・面積が数でない・見ている人数の形が違うとき
 */
const readScale = (body: Record<string, unknown>): Pick<TownTourCall, 'population' | 'area' | 'audience'> => {
  const { population, area } = body
  if ((population !== null && typeof population !== 'number') || typeof area !== 'number') {
    throw new Error('押し出された市町村紹介に人口と面積がありません')
  }
  return { population, area, audience: readAudience(body.audience) }
}

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
  return { code, prefecture, county, name, headline, sound: readPlaybackSound(body.sound), ...readScale(body) }
}

/**
 * Worker の応答（GET /api/overlay/town-tour）を、紹介として読む。
 *
 * @throws 出典（記事名・URL）か、大見出し・項目・振りのどれかが欠けている場合
 */
export const readTownTourIntro = (body: unknown): TownTourIntro => {
  const article: unknown = isRecord(body) ? body.article : undefined
  if (!isRecord(article) || typeof article.title !== 'string' || typeof article.url !== 'string') {
    throw new Error('Workerの応答に、紹介の出典（記事名と URL）がありません')
  }
  const tour: unknown = isRecord(body) ? body.tour : undefined
  if (!isRecord(tour) || typeof tour.hook !== 'string' || typeof tour.cue !== 'string') {
    throw new Error('Workerの応答の紹介に、大見出しか配信者への振りがありません')
  }
  const { points } = tour
  if (!Array.isArray(points) || points.length === 0) throw new Error('Workerの応答の紹介に、項目がありません')
  const readPoint = (point: unknown): TourPoint => {
    if (!isRecord(point) || typeof point.label !== 'string' || typeof point.text !== 'string') {
      throw new Error('Workerの応答の紹介に、見出しか文が欠けた項目があります')
    }
    return { label: point.label, text: point.text }
  }
  return {
    article: { title: article.title, url: article.url },
    tour: { hook: tour.hook, points: points.map(readPoint), cue: tour.cue },
  }
}

/**
 * 紹介から、画面に流す場面を順に並べる（大見出し → 項目 → 配信者への振り）。大見出しが空なら大見出しの場面を飛ばす。
 *
 * @param townName 市町村の名前（大見出しの見出し「この町、実は…」に使う）
 */
export const tourLinesOf = (tour: TownTourIntro['tour'], townName: string): TourLine[] => [
  ...(tour.hook === '' ? [] : [{ kind: 'hook', label: hookLabelOf(townName), text: tour.hook } as const]),
  ...tour.points.map((point) => ({ kind: 'point', label: point.label, text: point.text }) as const),
  { kind: 'cue', label: CUE_LABEL, text: tour.cue },
]
