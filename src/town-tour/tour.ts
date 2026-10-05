/**
 * 市町村紹介の呼び出しと紹介の形（合成ページの素材「市町村紹介」が受け取るもの）
 *
 * 素材は2つのものを Worker から受け取る。
 * - 呼び出し: トリガー（レイド・キーワード）や試し再生で、AlertChannel から WebSocket で押し出される。市町村と冒頭の一文と、
 *   演出で鳴らす音（sound.ts）と、着地で大きさの文（scale.ts）にする人口・面積・いま見ている人数と、
 *   全国制覇マップ（conquest.ts。issue #252）にするこれまでに紹介した市町村と、流しきったら記録するきっかけと、
 *   締めの認定証（certificate.ts。issue #253）で名誉町民にする相手と、ナレーション（narration.ts。issue #255）で読み上げるかを持つ
 *   （worker/town-tour-call.ts の TownTourCall と同じ形）
 * - クイズの最初の正解者: チャットで最初に正解した人が決まると、呼び出しと同じ接続へ type: answer を持つ形で押し出される
 *   （worker/town-tour-call.ts の TownTourAnswerMessage と同じ形。issue #251）
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
  /** 冒頭の都道府県当てクイズの出題の識別子。出題を開くときと、正解者を受け取るときに使う */
  readonly quizId: string
  /** クイズのあいだに出す一文（都道府県と郡を伏せたもの） */
  readonly quizHeadline: string
  readonly sound: TownTourPlaybackSound
  /** 住民基本台帳の人口。記録が無い村（北方領土の6村）は null */
  readonly population: number | null
  /** 面積（km²） */
  readonly area: number
  /** 人口と比べる、いま見ている人数。分からない（配信中でない）ときは null */
  readonly audience: TownTourAudience | null
  /** これまでに紹介した市町村のコード（制覇マップに塗る） */
  readonly visited: readonly string[]
  /** 流しきったら記録するきっかけと、冒頭で名前を出した相手。試し再生は記録しないので null */
  readonly visit: TownTourVisit | null
  /** 締めの認定証で名誉町民にする相手。認定証を出さない（キーワード）なら null */
  readonly honoraryCitizen: string | null
  /** 紹介をナレーションで読み上げるか（issue #255）。読み上げるなら、紹介が届いてから読み上げる文の合成を頼む */
  readonly narration: boolean
}

/** 流しきったら記録するきっかけ（レイドかキーワード）と相手（worker/town-tour-visits.ts の TownTourVisit からコードを除いたもの） */
export interface TownTourVisit {
  readonly occasion: 'raid' | 'keyword'
  readonly userName: string
}

/** 大見出しを支える1項目（worker/town-tour.ts の TownTourPoint と同じ形） */
export interface TourPoint {
  readonly label: string
  readonly text: string
}

/** 記事の代表画像（worker/town-image.ts の TownImage と同じ形） */
export interface TownTourImage {
  /** 画面に出す大きさの画像の URL（Wikimedia Commons） */
  readonly url: string
  /** 作者。パブリック・ドメインと CC0 で作者が無ければ空文字 */
  readonly artist: string
  /** ライセンスの名前（「CC BY-SA 4.0」「Public domain」） */
  readonly license: string
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
  /** ズームの着地のあとに出す代表画像。出せる画像が無い記事は null で、画像の場面を飛ばす（issue #254） */
  readonly image: TownTourImage | null
}

/** 画面に流す1場面。kind は場面の種類で、長さと描き方を決める（timeline.ts・view.ts） */
export interface TourLine {
  readonly kind: 'hook' | 'point' | 'cue'
  readonly label: string
  readonly text: string
}

/** 押し出されたもの。市町村紹介の呼び出しか、クイズの最初の正解者 */
export type TownTourMessage =
  | { readonly type: 'call'; readonly call: TownTourCall }
  | { readonly type: 'answer'; readonly quizId: string; readonly userName: string }

/** 市町村と冒頭の一文と出題の形だけを見る（音の設定は readPlaybackSound、人口と面積と見ている人数は readScale が理由つきで確かめる） */
const isTownTourCall = (
  value: Record<string, unknown>,
): value is Pick<TownTourCall, 'code' | 'prefecture' | 'county' | 'name' | 'headline' | 'quizId' | 'quizHeadline'> & Record<string, unknown> =>
  typeof value.code === 'string' &&
  typeof value.prefecture === 'string' &&
  typeof value.county === 'string' &&
  typeof value.name === 'string' &&
  typeof value.headline === 'string' &&
  typeof value.quizId === 'string' &&
  typeof value.quizHeadline === 'string'

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

/** 記録するきっかけとして読むもの */
const VISIT_OCCASIONS: readonly string[] = ['raid', 'keyword'] satisfies TownTourVisit['occasion'][]

/**
 * これまでに紹介した市町村と、流しきったら記録するきっかけを読む（null は試し再生で、記録しないことを表すのでそのまま通す）
 *
 * @throws 紹介した市町村がコード（文字列）の並びでない・記録するきっかけの形が違うとき
 */
const readConquest = (body: Record<string, unknown>): Pick<TownTourCall, 'visited' | 'visit'> => {
  const { visited, visit } = body
  if (!Array.isArray(visited) || !visited.every((code): code is string => typeof code === 'string')) {
    throw new Error('押し出された市町村紹介に、これまでに紹介した市町村がありません')
  }
  if (visit === null) return { visited, visit: null }
  if (!isRecord(visit) || typeof visit.userName !== 'string' || typeof visit.occasion !== 'string' || !VISIT_OCCASIONS.includes(visit.occasion)) {
    throw new Error('押し出された市町村紹介の、記録するきっかけが想定した形ではありません')
  }
  return { visited, visit: { occasion: visit.occasion === 'raid' ? 'raid' : 'keyword', userName: visit.userName } }
}

/**
 * 締めの認定証で名誉町民にする相手を読む（null は認定証を出さないことを表すのでそのまま通す）
 *
 * @throws 文字列でも null でもないとき
 */
const readHonoraryCitizen = (value: unknown): string | null => {
  if (value !== null && typeof value !== 'string') throw new Error('押し出された市町村紹介に、名誉町民にする相手がありません')
  return value
}

/**
 * ナレーションで読み上げるかを読む
 *
 * @throws 真偽値でないとき（欠けた呼び出しを「読み上げない」と読むと、壊れた押し出しに気づけないため）
 */
const readNarration = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new Error('押し出された市町村紹介に、ナレーションを読み上げるかがありません')
  return value
}

/**
 * WebSocket で押し出された文字列を、市町村紹介の呼び出しか、クイズの最初の正解者として読む。type が answer なら正解者、
 * type を持たなければ呼び出しとして読む。
 *
 * @throws JSONとして読めない・想定した形でない場合
 */
export const parseTownTourMessage = (payload: string): TownTourMessage => {
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    throw new Error('押し出された市町村紹介をJSONとして読めません')
  }
  if (!isRecord(body)) throw new Error('押し出された市町村紹介が想定した形ではありません')
  if (body.type === 'answer') {
    const { quizId, userName } = body
    if (typeof quizId !== 'string' || typeof userName !== 'string') throw new Error('押し出されたクイズの正解者が想定した形ではありません')
    return { type: 'answer', quizId, userName }
  }
  if (!isTownTourCall(body)) throw new Error('押し出された市町村紹介が想定した形ではありません')
  const { code, prefecture, county, name, headline, quizId, quizHeadline } = body
  return {
    type: 'call',
    call: {
      code,
      prefecture,
      county,
      name,
      headline,
      quizId,
      quizHeadline,
      sound: readPlaybackSound(body.sound),
      ...readScale(body),
      ...readConquest(body),
      honoraryCitizen: readHonoraryCitizen(body.honoraryCitizen),
      narration: readNarration(body.narration),
    },
  }
}

/**
 * 代表画像を読む（null は出せる画像が無いことを表すのでそのまま通す）
 *
 * @throws 欄が無い・URL か作者かライセンスが欠けているとき（作者とライセンスを出さずに画像を出さないため）
 */
const readImage = (value: unknown): TownTourImage | null => {
  if (value === null) return null
  if (!isRecord(value) || typeof value.url !== 'string' || typeof value.artist !== 'string' || typeof value.license !== 'string') {
    throw new Error('Workerの応答に、代表画像（URL・作者・ライセンス）がありません')
  }
  return { url: value.url, artist: value.artist, license: value.license }
}

/**
 * Worker の応答（GET /api/overlay/town-tour）を、紹介として読む。
 *
 * @throws 出典（記事名・URL）か、大見出し・項目・振りのどれかが欠けている・代表画像の形が違う場合
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
    image: readImage(isRecord(body) ? body.image : undefined),
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
