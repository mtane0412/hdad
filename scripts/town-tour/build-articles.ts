/**
 * 市町村紹介の一覧の各市町村に、日本語版 Wikipedia の記事名を対応させるスクリプト
 *
 * 使い方: node scripts/town-tour/build-articles.ts
 * src/town-tour/towns.json を読み、Wikidata のクエリサービス（SPARQL）に1回だけ問い合わせて、
 * src/town-tour/articles.json（コード → 記事名）を書き出す。一覧（build-data.ts）を作り直したら、続けてこれも作り直す。
 *
 * 市町村の名前は一意でない（府中市は東京都と広島県にあり、泊村は北海道に2つある）ので、記事を名前で検索しない。
 * Wikidata の全国地方公共団体コード（P429。5桁のコードに検査数字を付けた6桁）を持つ項目を引き、その日本語版の記事を採る。
 * 記事名は配信中に Worker（worker/town-wikipedia.ts）が本文を取りに行くのに使う。実行時に Wikidata を引かないのは、
 * 外部への呼び出しを1回減らすためと、曖昧な対応をここで止めて人が確かめられるようにするためである。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Wikidata の問い合わせ結果の1行（コードを持つ項目と、その日本語版の記事名） */
export type CodeArticle = {
  /** 検査数字を含む6桁のコード */
  code: string
  /** Wikidata の項目（Q で始まる識別子） */
  item: string
  /** 日本語版 Wikipedia の記事名 */
  title: string
}

/** 検査数字を除いたコードの形（5桁の数字） */
const CODE_PATTERN = /^\d{5}$/

/** 検査数字を求めるときに、上の桁から順に掛ける重み */
const CHECK_DIGIT_WEIGHTS = [6, 5, 4, 3, 2] as const

/** 検査数字を求める割り算の法 */
const CHECK_DIGIT_MODULUS = 11

/**
 * 5桁のコードに検査数字を付けて6桁にする（総務省の全国地方公共団体コードの規則）
 *
 * 各桁に重みを掛けた和を11で割った余りを、11から引いた数の1の位が検査数字になる。
 * 余りが0なら 11 の1の位で 1、余りが1なら 10 の1の位で 0 になる。
 *
 * @throws 5桁の数字でないとき
 */
export const withCheckDigit = (code: string): string => {
  if (!CODE_PATTERN.test(code)) throw new Error(`全国地方公共団体コードは5桁の数字で渡してください: ${code}`)
  const sum = CHECK_DIGIT_WEIGHTS.reduce((total, weight, index) => total + Number(code.charAt(index)) * weight, 0)
  return `${code}${(CHECK_DIGIT_MODULUS - (sum % CHECK_DIGIT_MODULUS)) % 10}`
}

/**
 * 同じコードを持つ項目が複数あるときに採る項目（キーは5桁のコード）
 *
 * Wikidata の誤りで、市町村以外の項目にも P429 が付いていることがある。規則（項目の種類 P31 など）で選ぶと、
 * 種類が付いていない市町村の項目を落とす別の誤りを招くので、見つかった分だけを人が確かめて表で持つ。
 */
const PREFERRED_ITEMS: ReadonlyMap<string, string> = new Map([
  // 読谷村文化センター（Q138722100）にも読谷村のコードが付いている
  ['47324', 'Q973994'],
])

/**
 * 一覧の各市町村に、記事名を対応させる
 *
 * @param codes 一覧の市町村のコード（5桁）
 * @param rows Wikidata の問い合わせ結果
 * @param preferredItems 同じコードの項目が複数あるときに採る項目
 * @returns コード（5桁）から記事名を引く表
 * @throws 記事の見つからない市町村があるとき、同じコードの項目が複数あって表で指名されていないとき
 */
export const resolveArticles = (
  codes: readonly string[],
  rows: readonly CodeArticle[],
  preferredItems: ReadonlyMap<string, string>,
): Record<string, string> => {
  const titlesByCode = new Map<string, Map<string, string>>()
  for (const { code, item, title } of rows) {
    const titles = titlesByCode.get(code) ?? new Map<string, string>()
    titles.set(item, title)
    titlesByCode.set(code, titles)
  }

  const problems: string[] = []
  const articles: Record<string, string> = {}
  for (const code of codes) {
    const titles = titlesByCode.get(withCheckDigit(code)) ?? new Map<string, string>()
    const preferred = preferredItems.get(code)
    const title = preferred === undefined ? (titles.size === 1 ? [...titles.values()][0] : undefined) : titles.get(preferred)
    if (title === undefined) {
      problems.push(`${code}: 記事を1つに決められません（候補: ${[...titles].map(([item, name]) => `${item} ${name}`).join('・') || 'なし'}）`)
      continue
    }
    articles[code] = title
  }
  if (problems.length > 0) throw new Error(`記事名を解決できない市町村があります\n${problems.join('\n')}`)
  return articles
}

/** P429 を持つ項目と、その日本語版の記事名をすべて引く問い合わせ */
const QUERY = `SELECT ?code ?item ?title WHERE {
  ?item wdt:P429 ?code .
  ?article schema:about ?item ; schema:isPartOf <https://ja.wikipedia.org/> ; schema:name ?title .
}`

const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql'

/** Wikimedia の利用規約が求める、連絡先の分かる User-Agent */
const USER_AGENT = 'hdad-town-tour/1.0 (https://github.com/mtane0412/hdad)'

/** SPARQL の応答のうち、使う部分 */
type SparqlResponse = { results: { bindings: { code: { value: string }; item: { value: string }; title: { value: string } }[] } }

const fetchCodeArticles = async (): Promise<CodeArticle[]> => {
  const response = await fetch(SPARQL_ENDPOINT, {
    method: 'POST',
    headers: { 'Accept': 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
    body: new URLSearchParams({ query: QUERY }),
  })
  if (!response.ok) throw new Error(`Wikidata への問い合わせに失敗しました: ${response.status} ${await response.text()}`)
  const body = (await response.json()) as SparqlResponse
  return body.results.bindings.map((binding) => ({
    code: binding.code.value,
    // 項目は http://www.wikidata.org/entity/Q973994 の形で返るので、末尾の識別子だけにする
    item: binding.item.value.slice(binding.item.value.lastIndexOf('/') + 1),
    title: binding.title.value,
  }))
}

const repositoryRoot = resolve(import.meta.dirname, '../..')

const main = async (): Promise<void> => {
  const towns: { code: string }[] = JSON.parse(readFileSync(resolve(repositoryRoot, 'src/town-tour/towns.json'), 'utf8'))
  const articles = resolveArticles(
    towns.map((town) => town.code),
    await fetchCodeArticles(),
    PREFERRED_ITEMS,
  )
  writeFileSync(resolve(repositoryRoot, 'src/town-tour/articles.json'), `${JSON.stringify(articles, null, 2)}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
