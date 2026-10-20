/**
 * チャットで推理の解説に添える画像を、Wikipedia の記事の代表画像から作り直すスクリプト
 *
 * 使い方: npm run build:chat-deduction-images
 * src/chat-deduction/problems.json の各問題の記事名（wikipedia）から、日本語版 Wikipedia の PageImages で記事の代表画像の
 * ファイル名をまとめて引き、市町村紹介と同じ判定（worker/town-image.ts の fetchTownImage。地図・紋章・CC でも PD でもない・
 * 作者の表記が要るのに無い画像は出さない）で、画面に出す大きさの URL・作者・ライセンスを取る。結果は
 * src/chat-deduction/images.json（問題のID → 画像か null）に書き出す。問題を足した・記事名を変えたら作り直す。
 *
 * 配信中に Worker が Wikipedia を引かずにここで固めるのは、どの画像が映るかを配信の前に人が確かめられるようにするためと、
 * 配信中の外部への呼び出しを増やさないためである。
 *
 * 注意: worker/ の部品を読み込むので、Node の型の剥ぎ取りだけでは動かない（拡張子の無い import を解決できない）。
 * npm スクリプトは jiti で読み込む。
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChatDeductionImage } from '../../src/chat-deduction/images'
import { readChatDeductionProblemSets } from '../../src/chat-deduction/problems'
import problemSets from '../../src/chat-deduction/problems.json'
import { fetchTownImage } from '../../worker/town-image'
import { API_ENDPOINT, USER_AGENT } from '../../worker/town-wikipedia'

/** 1回の問い合わせで頼める記事名の数（MediaWiki の API の上限） */
const MAX_TITLES_PER_QUERY = 50

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** 表記の揃え・転送の一覧（{ from, to } の配列）を、元の記事名 → 先の記事名の表にする */
const renamesOf = (value: unknown): ReadonlyMap<string, string> =>
  new Map(
    (Array.isArray(value) ? value : []).flatMap((entry: unknown): [string, string][] =>
      isRecord(entry) && typeof entry.from === 'string' && typeof entry.to === 'string' ? [[entry.from, entry.to]] : [],
    ),
  )

/**
 * PageImages の応答から、頼んだ記事名ごとの代表画像のファイル名を取り出す
 *
 * 表記の揃え（normalized）と転送（redirects）を、その順に辿って頼んだ記事名に結び付ける。
 *
 * @param body action=query&prop=pageimages&formatversion=2 の応答
 * @param titles 頼んだ記事名
 * @returns 頼んだ記事名 → 代表画像のファイル名（代表画像の無い記事は null）
 * @throws 応答の形が違う・記事が無い・頼んだ記事が応答に見当たらないとき
 */
export const pageImageFilesOf = (body: unknown, titles: readonly string[]): ReadonlyMap<string, string | null> => {
  const query = isRecord(body) ? body.query : undefined
  if (!isRecord(query) || !Array.isArray(query.pages)) throw new Error('Wikipedia の応答の形が違います')
  const normalized = renamesOf(query.normalized)
  const redirects = renamesOf(query.redirects)
  const pages = new Map(
    query.pages.flatMap((page: unknown): [string, Record<string, unknown>][] => (isRecord(page) && typeof page.title === 'string' ? [[page.title, page]] : [])),
  )
  return new Map(
    titles.map((title): [string, string | null] => {
      const normalizedTitle = normalized.get(title) ?? title
      const page = pages.get(redirects.get(normalizedTitle) ?? normalizedTitle)
      if (page === undefined) throw new Error(`Wikipedia の応答に記事「${title}」が見当たりません`)
      if (page.missing === true) throw new Error(`Wikipedia に記事「${title}」がありません。problems.json の記事名を確かめてください`)
      return [title, typeof page.pageimage === 'string' ? page.pageimage : null]
    }),
  )
}

/** 記事名の一覧の代表画像のファイル名を、上限ごとに分けて問い合わせる */
const fetchPageImageFiles = async (titles: readonly string[]): Promise<ReadonlyMap<string, string | null>> => {
  const files = new Map<string, string | null>()
  for (let start = 0; start < titles.length; start += MAX_TITLES_PER_QUERY) {
    const chunk = titles.slice(start, start + MAX_TITLES_PER_QUERY)
    const url = new URL(API_ENDPOINT)
    url.search = new URLSearchParams({
      action: 'query',
      prop: 'pageimages',
      piprop: 'name',
      pilicense: 'free',
      pilimit: 'max',
      redirects: '1',
      format: 'json',
      formatversion: '2',
      titles: chunk.join('|'),
    }).toString()
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    if (!response.ok) throw new Error(`Wikipedia が失敗を返しました: ${response.status}`)
    for (const [title, file] of pageImageFilesOf(await response.json(), chunk)) files.set(title, file)
  }
  return files
}

const main = async (): Promise<void> => {
  const problems = readChatDeductionProblemSets(problemSets).flatMap((set) => set.problems)
  const files = await fetchPageImageFiles([...new Set(problems.map((problem) => problem.wikipedia))])
  const images: Record<string, ChatDeductionImage | null> = {}
  for (const problem of problems) {
    const file = files.get(problem.wikipedia) ?? null
    const image = file === null ? null : await fetchTownImage(fetch, file)
    // 画面には出さない Commons の説明は持たない
    images[problem.id] = image === null ? null : { url: image.url, artist: image.artist, license: image.license }
    console.log(`${problem.id}（${problem.wikipedia}）: ${image === null ? '画像なし' : `${file} / ${image.license}`}`)
  }
  const repositoryRoot = resolve(import.meta.dirname, '../..')
  writeFileSync(resolve(repositoryRoot, 'src/chat-deduction/images.json'), `${JSON.stringify(images, null, 2)}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
