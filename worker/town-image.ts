/**
 * 市町村の記事の代表画像を、作者とライセンスと一緒に取ってくる（issue #254）
 *
 * 代表画像のファイル名は記事の本文と同じ問い合わせで PageImages（prop=pageimages）から受け取り
 * （town-wikipedia.ts の fetchTownArticle）、ここでは Wikimedia Commons の imageinfo（extmetadata）で
 * 作者とライセンスと、画面に出す大きさの画像の URL を取る。日本語版 Wikipedia の API に問い合わせれば、
 * Commons にある画像の情報もまとめて返る。
 * 同じ問い合わせで画像の説明（ImageDescription。日本語があれば日本語）も取り、紹介を作る LLM に写真の説明を書かせる材料にする。
 *
 * 出さない画像は null にする（失敗ではなく決めた形で、合成ページは画像の場面を飛ばす）。
 * - 地図・位置図・市町村章・写真の無い記事の代わりの絵（Gthumb.svg）。ファイル名の型で見分け、問い合わせない
 *   （全1,747件の記事を調べた時点では、型に当たるのは代わりの絵の1件だけだった。記事は書き換わるので型は残す）
 * - ライセンスがクリエイティブ・コモンズでもパブリック・ドメインでもない・取れない画像（GFDL・FAL など）
 * - 作者の表記が要るのに作者が無い・画面に収まらないほど長い画像
 *
 * 注意: 問い合わせの失敗（Wikipedia が失敗を返した・画像の情報が無い）は外したのではないので、黙って null にせず投げる。
 */
import { withTimeout } from './timeout'
import { API_ENDPOINT, TownArticleError, USER_AGENT, WIKIPEDIA_TIMEOUT_MS } from './town-wikipedia'

/** 画面に出す画像の幅（px）。配信画面（1920×1080）の中ほどに収める大きさで足り、元の大きな画像を読ませない */
export const TOWN_IMAGE_WIDTH = 1280

/**
 * 作者の表記の長さの上限（文字）。これを超える画像は出さない。
 * 組み写真（モンタージュ）では写真ごとの撮影者が並んで数百文字になり、画面の隅に収まらない（全件のうち14件）。
 */
export const MAX_ARTIST_LENGTH = 100

/** 出す画像 */
export interface TownImage {
  /** 画面に出す大きさ（TOWN_IMAGE_WIDTH）の画像の URL */
  url: string
  /** 作者。パブリック・ドメインと CC0 で作者が無ければ空文字 */
  artist: string
  /** ライセンスの名前（「CC BY-SA 4.0」「Public domain」） */
  license: string
  /**
   * Commons に書かれた画像の説明（HTML を外した文）。無ければ空文字。
   * 画面には出さず、紹介を作る LLM が写真の説明を書く材料にする（誰でも編集できるので、そのまま画面に出さない）
   */
  description: string
}

/**
 * 地図・位置図・市町村章・旗のファイル名の型。
 * 「Symbol」は町章（Symbol of 〜）にも塔の名前（Symbol_Tower_MiRAi）にも使われるので入れない。
 */
const MAP_OR_EMBLEM_PATTERN = /位置|Location|Locator|地図|(^|[^a-z])map([^a-z]|$)|章|Emblem|Flag|旗/i

/** SVG の拡張子。写真は SVG で上がらず、SVG の代表画像は地図・市町村章・写真の無い記事の代わりの絵である */
const SVG_PATTERN = /\.svg$/i

/** 画像を出してよいライセンスの機械向けの名前（extmetadata の License）。クリエイティブ・コモンズ（cc-by-sa-4.0 など）・CC0・パブリック・ドメイン */
const FREE_LICENSE_PATTERN = /^(cc-|cc0$|pd$)/

/** 作者の表記が要らないライセンス */
const NO_ATTRIBUTION_LICENSES: ReadonlySet<string> = new Set(['cc0', 'pd'])

/**
 * ファイル名から、出してよい画像かを決める（地図・位置図・市町村章でないか）
 */
export const isShowableImageFile = (fileName: string): boolean => !SVG_PATTERN.test(fileName) && !MAP_OR_EMBLEM_PATTERN.test(fileName)

/** Unicode の符号位置の最大値。これを超える数値の文字参照は戻さない */
const MAX_CODE_POINT = 0x10ffff

/** 名前付きの文字参照のうち、作者の欄に出てくるもの */
const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/**
 * 作者・説明の欄（HTML）を文にする。タグを外し、文字参照を戻し、空白をまとめる。
 * 戻せない文字参照はそのまま残す（作者の名前を黙って欠けさせない）。
 */
const textOfHtml = (html: string): string =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, name: string) => {
      if (!name.startsWith('#')) return NAMED_ENTITIES[name.toLowerCase()] ?? entity
      const isHex = name[1] === 'x' || name[1] === 'X'
      const codePoint = Number.parseInt(name.slice(isHex ? 2 : 1), isHex ? 16 : 10)
      // Unicode の範囲外の値は String.fromCodePoint が投げるので、戻さずにそのまま残す
      return codePoint <= MAX_CODE_POINT ? String.fromCodePoint(codePoint) : entity
    })
    .replace(/\s+/g, ' ')
    .trim()

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** extmetadata の1項目（{ value: "..." }）の文字列。無ければ空文字 */
const metadataValue = (metadata: Record<string, unknown>, key: string): string => {
  const entry = metadata[key]
  return isRecord(entry) && typeof entry.value === 'string' ? entry.value : ''
}

/**
 * 代表画像のファイル名から、出す画像を取ってくる
 *
 * @param fetchImpl 通信（テストでは代役が渡る）。ここで時間制限をかける
 * @param fileName 代表画像のファイル名（名前空間の「File:」は付けない）
 * @returns 出す画像。地図・町章のファイル名・ライセンスや作者が条件に合わない画像は null
 * @throws TownArticleError Wikipedia が失敗を返した・画像の情報が無い・応答の形が違うとき
 */
export const fetchTownImage = async (fetchImpl: typeof fetch, fileName: string): Promise<TownImage | null> => {
  if (!isShowableImageFile(fileName)) return null

  const url = new URL(API_ENDPOINT)
  url.search = new URLSearchParams({
    action: 'query',
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    iiurlwidth: String(TOWN_IMAGE_WIDTH),
    iiextmetadatafilter: 'License|LicenseShortName|Artist|ImageDescription',
    // 説明が複数の言語で書かれていれば日本語を選ばせる（日本語が無ければ別の言語が返る）
    iiextmetadatalanguage: 'ja',
    format: 'json',
    formatversion: '2',
    titles: `File:${fileName}`,
  }).toString()

  const response = await withTimeout(fetchImpl, WIKIPEDIA_TIMEOUT_MS, 'Wikipedia')(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!response.ok) throw new TownArticleError(`Wikipedia が画像の情報で失敗を返しました（${fileName}）: ${response.status}`)

  const body: unknown = await response.json()
  const page = isRecord(body) && isRecord(body.query) && Array.isArray(body.query.pages) ? body.query.pages[0] : undefined
  const info: unknown = isRecord(page) && Array.isArray(page.imageinfo) ? page.imageinfo[0] : undefined
  if (!isRecord(info) || typeof info.thumburl !== 'string' || !isRecord(info.extmetadata)) {
    throw new TownArticleError(`Wikipedia から代表画像の情報が取れませんでした: ${fileName}`)
  }

  const licenseCode = metadataValue(info.extmetadata, 'License')
  const license = metadataValue(info.extmetadata, 'LicenseShortName')
  const artist = textOfHtml(metadataValue(info.extmetadata, 'Artist'))
  if (!FREE_LICENSE_PATTERN.test(licenseCode) || license === '') return null
  if (artist === '' && !NO_ATTRIBUTION_LICENSES.has(licenseCode)) return null
  if ([...artist].length > MAX_ARTIST_LENGTH) return null
  return { url: info.thumburl, artist, license, description: textOfHtml(metadataValue(info.extmetadata, 'ImageDescription')) }
}
