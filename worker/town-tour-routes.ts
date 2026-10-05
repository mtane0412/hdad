/**
 * 市町村紹介の経路
 *
 * - GET /api/overlay/town-tour?key=&code=: コードの市町村の紹介を作って返す
 * - GET /api/overlay/town-tour/socket?key=: 合成ページの素材「市町村紹介」の WebSocket の接続を配送先（AlertChannel）へ引き渡す
 * - POST /api/admin/town-tour/demo: 管理画面の試し再生。市町村を1つ引いて素材へ押し出す（トリガーと同じ配送の経路を通す）
 * - GET /api/admin/town-tour/sound: 演出で鳴らす音の設定。未保存ならどの枠も鳴らさない設定（issue #243）
 * - PUT /api/admin/town-tour/sound: 音の設定を検証して保存する（問題があれば index.ts が問題点付きの400にする）
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
import { connectTownTourSocket, pushTownTour } from './alert-channel'
import { listMedia } from './media'
import { loadOverlayKey } from './overlay-key'
import { HttpError, STATUS, requireAdmin, requireOverlayKey, type Context } from './http'
import { overlayKeyTag } from './overlay-key'
import { latestViewerCount, recordFailure } from './stats-store'
import { generateTownTour } from './town-tour'
import { pickTown, townTourCallOf } from './town-tour-call'
import { loadTownTourSound, parseTownTourSound, playbackSoundOf, saveTownTourSound } from './town-tour-sound'
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

/** GET /api/overlay/town-tour/socket?key=: 合成ページからのWebSocketの接続を、市町村紹介の呼び出しを受け取る接続として配送先へ引き渡す */
export const townTourSocket = async (context: Context): Promise<Response> => {
  const key = await requireOverlayKey(context)
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectTownTourSocket(context.env.ALERTS, context.request, await overlayKeyTag(key))
}

/**
 * POST /api/admin/town-tour/demo: 管理画面の試し再生。市町村を1つ引き、試しと分かる一文を添えて素材へ押し出す。
 *
 * トリガーと同じ配送の経路（AlertChannel）を通すので、合成ページを開いていれば OBS の画面にもそのまま流れる。
 * 何を引いたかを画面に出せるよう、押し出したものを返す。音もトリガーと同じく保存済みの設定で鳴らす（聞き比べられるように）。
 *
 * 注意: 配送先の失敗は黙って成功にせず 502 で返す（管理画面に理由を出す）。
 * 注意: 音を選んでいるのにオーバーレイ用キーが未発行なら、音のURLを作れないので押し出さずに 409 で返す（黙って無音で流さない）。
 */
export const postTownTourDemo = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { STORE } = context.env
  const [sound, overlayKey, liveViewers] = await Promise.all([
    loadTownTourSound(STORE),
    loadOverlayKey(STORE),
    latestViewerCount(context.env.DB),
  ])
  const playbackSound = ((): ReturnType<typeof playbackSoundOf> => {
    try {
      return playbackSoundOf(sound, overlayKey)
    } catch (error) {
      throw new HttpError(STATUS.conflict, 'overlay-key-missing', error instanceof Error ? error.message : String(error))
    }
  })()
  const call = townTourCallOf(pickTown(Math.random), { occasion: 'demo' }, playbackSound, liveViewers)
  try {
    await pushTownTour(context.env.ALERTS, call)
  } catch (error) {
    throw new HttpError(STATUS.badGateway, 'town-tour-push-failed', error instanceof Error ? error.message : String(error))
  }
  return Response.json(call)
}

/** GET /api/admin/town-tour/sound: 演出で鳴らす音の設定。未保存ならどの枠も鳴らさない設定が返る */
export const getTownTourSound = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json(await loadTownTourSound(context.env.STORE))
}

/**
 * PUT /api/admin/town-tour/sound: 音の設定を検証して保存し、保存したものを返す。
 *
 * @throws ConfigError 設定に問題がある場合（index.ts が問題点付きの400にする）
 */
export const putTownTourSound = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { request, env } = context
  const body: unknown = await request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const kinds = new Map((await listMedia(env.MEDIA)).map((item) => [item.id, item.kind]))
  const sound = parseTownTourSound(body, (mediaId) => kinds.get(mediaId) ?? null)
  await saveTownTourSound(env.STORE, sound)
  return Response.json(sound)
}
