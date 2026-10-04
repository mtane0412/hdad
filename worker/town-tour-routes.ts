/**
 * 市町村紹介の経路（GET /api/overlay/town-tour?key=&code=）
 *
 * 合成ページの素材（issue #229）が、レイドで引いた市町村のコードを渡して呼ぶ。Worker はコードから記事名を引き
 * （src/town-tour/articles.json）、Wikipedia の記事を材料に LLM に紹介を作らせ、出典の URL と一緒に返す。
 *
 * 紹介は貯めずにその都度作る。待ち時間は合成ページが日本地図の演出のあいだに吸収する（経緯は docs/decisions/town-tour.md）。
 * Twitch の Webhook の中で作らないのは、Free プランの waitUntil が30秒で打ち切られ、LLM の待ち時間の上限（60秒）に足りないためである。
 *
 * 一覧（towns.json）と記事名の表（articles.json）は src/town-tour/ にあり、合成ページと同じものを読む
 * （Worker から src/ を読み込む例外。.claude/rules/town-tour.md）。
 *
 * 注意: 失敗は空の紹介で取り繕わず 502 で返し、ダッシュボードの失敗の記録（collection_failures）にも残す（Fail-Fast）。
 */
import articles from '../src/town-tour/articles.json'
import towns from '../src/town-tour/towns.json'
import { HttpError, STATUS, requireOverlayKey, type Context } from './http'
import { recordFailure } from './stats-store'
import { generateTownTour } from './town-tour'
import { fetchTownArticle, pickTownMaterial } from './town-wikipedia'

/** コードから記事名を引く表。JSON のキーは文字列なので Map に移しておき、プロトタイプのキー（toString など）に当たらないようにする */
const articleTitles: ReadonlyMap<string, string> = new Map(Object.entries(articles))

/** GET /api/overlay/town-tour?key=&code=: コードの市町村の紹介を作って返す */
export const getTownTour = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  const code = context.url.searchParams.get('code') ?? ''
  const town = towns.find((candidate) => candidate.code === code)
  const title = articleTitles.get(code)
  if (town === undefined || title === undefined) {
    throw new HttpError(STATUS.notFound, 'unknown-town', `市町村の一覧に無いコードです: ${code}`)
  }

  try {
    const article = await fetchTownArticle(context.fetch, title)
    const tour = await generateTownTour(context.llm, {
      prefecture: town.prefecture,
      county: town.county,
      name: town.name,
      material: pickTownMaterial(article.extract),
    })
    return Response.json({ ...town, article: { title: article.title, url: article.url }, tour })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // 記録に失敗しても、紹介を作れなかった理由を記録の失敗で置き換えない。記録の失敗も黙って捨てず、応答の理由に添える
    const recordProblem = await recordFailure(
      context.env.DB,
      'town-tour-failed',
      `市町村紹介（${town.prefecture}${town.county}${town.name}）を作れませんでした: ${reason}`,
      context.now,
    ).then(
      () => '',
      (recordError: unknown) => `（失敗の記録にも失敗しました: ${recordError instanceof Error ? recordError.message : String(recordError)}）`,
    )
    throw new HttpError(STATUS.badGateway, 'town-tour-failed', `${reason}${recordProblem}`)
  }
}
