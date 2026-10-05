/**
 * 市町村の紹介の材料を、日本語版 Wikipedia の記事から取ってくる
 *
 * 記事名は一覧のコードから引いたもの（src/town-tour/articles.json。scripts/town-tour/build-articles.ts が
 * Wikidata の全国地方公共団体コードから作る）を受け取り、ここでは名前で検索しない。
 *
 * 本文は TextExtracts（action=query&prop=extracts）の見出し付きプレーンテキストで取る。HTML や wikitext より
 * 小さく、そのまま LLM に渡せる。府中市 (広島県) のような長い記事でも応答は 70KB ほどで、
 * Workers Free の CPU 時間（1回 10ms）の中で解析できる。
 * 記事の全文は LLM に渡さず、見出しの名前で紹介に使う系統の節だけを拾い（pickTownMaterial）、系統ごとに長さを切る。
 * 見出しの名前は記事ごとに違う（名物の節は「名物」「名品」「特産品」などと書かれる）ので、系統ごとに名前の型を持つ。
 *
 * 同じ問い合わせで、記事の代表画像のファイル名も PageImages（prop=pageimages）から受け取る。作者とライセンスは
 * town-image.ts が別に取る（issue #254）。
 *
 * 注意: Wikipedia の本文は CC BY-SA なので、紹介を出すときは出典として記事の URL を添える。
 * URL は転送（redirects）を解決したあとの記事名で作る。
 */
import { withTimeout } from './timeout'

/**
 * Wikipedia への1回の問い合わせを待つ時間の上限（ミリ秒）。
 *
 * 値を引くだけの Gyazo（15秒）と同じにする。合成ページは日本地図の演出のあいだに待つので、
 * これを超えて待たせるよりは失敗を出したほうがよい。
 */
export const WIKIPEDIA_TIMEOUT_MS = 15_000

/** 系統ごとの材料の長さの上限（文字）。5系統と冒頭を合わせても、LLM に渡す材料が数千文字に収まるようにする */
export const MAX_SECTION_LENGTH = 1_000

export const API_ENDPOINT = 'https://ja.wikipedia.org/w/api.php'
const ARTICLE_BASE_URL = 'https://ja.wikipedia.org/wiki/'

/** Wikimedia の利用規約が求める、連絡先の分かる User-Agent */
export const USER_AGENT = 'hdad-town-tour/1.0 (https://github.com/mtane0412/hdad)'

/** 記事が取れなかったときの失敗（記事が無い・本文が空・Wikipedia が失敗を返した・応答の形が違う） */
export class TownArticleError extends Error {}

/** 取ってきた記事 */
export interface TownArticle {
  /** 転送を解決したあとの記事名 */
  title: string
  /** 出典として添える記事の URL */
  url: string
  /** 見出し付きのプレーンテキストの本文（見出しは「== 歴史 ==」の形） */
  extract: string
  /** 代表画像（PageImages）のファイル名（「File:」は付かない）。自由なライセンスの代表画像が無ければ null（issue #254） */
  image: string | null
}

/** 紹介の材料。記事に当てはまる節が無い系統は空文字になる */
export interface TownMaterial {
  /** 記事の冒頭と「概要」の節 */
  lead: string
  /** 地理（位置・隣接する自治体など） */
  geography: string
  /** 名前の由来 */
  origin: string
  /** 歴史 */
  history: string
  /** 名物・名産 */
  specialty: string
  /** そのほかの話題（観光・祭り・出身者・伝説など） */
  topics: string
}

/**
 * 系統ごとの見出しの名前の型。上から順に照らし、最初に当てはまった系統に入れる。
 *
 * 「町名」は町の名前の由来ではなく町内の地名の一覧であることが多い（葛飾区の「町名」）ので、名前の由来に入れない。
 * 「祭」だけで照らすと「葬祭場」に、「文化」だけで照らすと「文化施設」（施設の一覧）に当たるので、語を長くとる。
 */
const SECTION_PATTERNS: readonly (readonly [keyof TownMaterial, RegExp])[] = [
  ['lead', /^概要$/],
  ['origin', /由来|語源|名称|^(市|村|区)名$/],
  ['history', /歴史|沿革/],
  ['geography', /地理|位置|地勢/],
  ['specialty', /名物|名産|特産|名品|物産|郷土料理|グルメ/],
  ['topics', /観光|名所|旧跡|史跡|祭り|祭事|祭礼|まつり|出身|有名人|著名|ゆかり|伝説|伝承|ゆるキャラ|マスコット|舞台|登場|文化財|UMA/],
]

/**
 * 拾わない見出しの名前の型。町名・大字の一覧は名前が並ぶだけで、紹介の材料にならないうえに系統の長さの枠を埋めてしまう。
 * 系統の見出しより先に照らす（「町名一覧」が「名」の付く系統に当たらないように）。
 */
const SKIPPED_HEADING_PATTERN = /一覧|町名|大字|字名/

/** 見出しの行（「== 歴史 ==」「=== 語源 ===」）。= の数が見出しの深さ */
const HEADING_PATTERN = /^(={2,})\s*(.+?)\s*\1$/

/** 本文の1つの見出しとその直下の行 */
interface Section {
  level: number
  heading: string
  lines: string[]
}

/** 本文を、冒頭の行と見出しごとの節に分ける */
const splitSections = (extract: string): { leadLines: string[]; sections: Section[] } => {
  const leadLines: string[] = []
  const sections: Section[] = []
  for (const line of extract.split('\n')) {
    const heading = HEADING_PATTERN.exec(line.trim())
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      sections.push({ level: heading[1].length, heading: heading[2], lines: [] })
      continue
    }
    if (line.trim() === '') continue
    ;(sections.at(-1)?.lines ?? leadLines).push(line.trim())
  }
  return { leadLines, sections }
}

/** 文字数（コードポイント）で上限まで切る */
const truncate = (text: string, maxLength: number): string => [...text].slice(0, maxLength).join('')

/** 見出しが当てはまる系統。拾わない見出しなら 'skipped'、どれにも当てはまらなければ undefined */
const kindOf = (heading: string): keyof TownMaterial | 'skipped' | undefined =>
  SKIPPED_HEADING_PATTERN.test(heading) ? 'skipped' : SECTION_PATTERNS.find(([, pattern]) => pattern.test(heading))?.[0]

/**
 * 記事の本文から、紹介の材料を系統ごとに拾う
 *
 * 見出しが系統に当てはまれば、その節をその系統に入れる。当てはまらない子の見出しの節は、親の系統に入れる
 * （「歴史」の下の「年表」など）。子の見出しが親と別の系統に当てはまればそちらに入れる
 * （府中市 (広島県) では「名物」が「名所・旧跡・観光スポット」の下にある）。
 * どの系統にも当てはまらない見出しの下も照らし続ける（「市名」の下の「語源」のように、子だけが当てはまることがある）。
 */
export const pickTownMaterial = (extract: string): TownMaterial => {
  const { leadLines, sections } = splitSections(extract)
  const picked: Record<keyof TownMaterial, string[]> = { lead: leadLines, geography: [], origin: [], history: [], specialty: [], topics: [] }

  // いま開いている見出しの深さと系統（浅い順）。次の見出しが来たら、それと同じか深いものを閉じる
  const open: { level: number; kind: keyof TownMaterial | 'skipped' | undefined }[] = []
  for (const section of sections) {
    while ((open.at(-1)?.level ?? 0) >= section.level) open.pop()
    const ownKind = kindOf(section.heading)
    const kind = ownKind ?? open.at(-1)?.kind
    open.push({ level: section.level, kind })
    if (kind === undefined || kind === 'skipped') continue
    // 親から受け継いだ節は、どの話題かが分かるよう見出しも材料に残す
    picked[kind].push(...(ownKind === undefined ? [section.heading] : []), ...section.lines)
  }

  const join = (lines: string[]): string => truncate(lines.join('\n'), MAX_SECTION_LENGTH)
  return {
    lead: join(picked.lead),
    geography: join(picked.geography),
    origin: join(picked.origin),
    history: join(picked.history),
    specialty: join(picked.specialty),
    topics: join(picked.topics),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** 記事名から、記事の URL を作る（Wikipedia の URL は空白を _ にする） */
const articleUrl = (title: string): string => `${ARTICLE_BASE_URL}${encodeURIComponent(title.replaceAll(' ', '_'))}`

/**
 * 記事名から、記事の本文を取ってくる
 *
 * @param fetchImpl 通信（テストでは代役が渡る）。ここで時間制限をかける
 * @param title 記事名（src/town-tour/articles.json の値）
 * @throws TownArticleError 記事が無い・本文が空・Wikipedia が失敗を返した・応答の形が違うとき
 */
export const fetchTownArticle = async (fetchImpl: typeof fetch, title: string): Promise<TownArticle> => {
  const url = new URL(API_ENDPOINT)
  url.search = new URLSearchParams({
    action: 'query',
    // 代表画像のファイル名も同じ問い合わせで受け取る。作者とライセンスは town-image.ts が別に取る
    prop: 'extracts|pageimages',
    piprop: 'name',
    pilicense: 'free',
    explaintext: '1',
    exsectionformat: 'wiki',
    redirects: '1',
    format: 'json',
    formatversion: '2',
    titles: title,
  }).toString()

  const response = await withTimeout(fetchImpl, WIKIPEDIA_TIMEOUT_MS, 'Wikipedia')(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!response.ok) throw new TownArticleError(`Wikipedia が失敗を返しました（${title}）: ${response.status}`)

  const body: unknown = await response.json()
  const page = isRecord(body) && isRecord(body.query) && Array.isArray(body.query.pages) ? body.query.pages[0] : undefined
  if (!isRecord(page)) throw new TownArticleError(`Wikipedia の応答の形が違います（${title}）`)
  if (page.missing === true) throw new TownArticleError(`Wikipedia に記事がありません: ${title}`)
  if (typeof page.title !== 'string' || typeof page.extract !== 'string' || page.extract.trim() === '') {
    throw new TownArticleError(`Wikipedia の記事の本文が取れませんでした: ${title}`)
  }
  return { title: page.title, url: articleUrl(page.title), extract: page.extract, image: typeof page.pageimage === 'string' ? page.pageimage : null }
}
