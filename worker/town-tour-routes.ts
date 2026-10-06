/**
 * 市町村紹介の経路
 *
 * - GET /api/overlay/town-tour?key=&code=: コードの市町村の紹介を作って返す
 * - POST /api/overlay/town-tour/quiz?key=: 合成ページが冒頭の都道府県当てクイズを流しはじめたときに、出題を開く（issue #251）
 * - POST /api/overlay/town-tour/visit?key=: 合成ページが紹介を流しきったら、紹介した市町村として記録する（issue #252）
 * - GET /api/overlay/town-tour/socket?key=: 合成ページの素材「市町村紹介」の WebSocket の接続を配送先（AlertChannel）へ引き渡す
 * - POST /api/admin/town-tour/demo: 管理画面の試し再生。市町村を1つ引いて素材へ押し出す（トリガーと同じ配送の経路を通す）
 * - GET /api/admin/town-tour/sound: 演出で鳴らす音の設定。未保存ならどの枠も鳴らさない設定（issue #243）
 * - PUT /api/admin/town-tour/sound: 音の設定を検証して保存する（問題があれば index.ts が問題点付きの400にする）
 * - POST /api/overlay/town-tour/narration?key=: 読み上げる文1件 { text } を、ナレーションの設定の話者と速度で合成し、WAV を返す（issue #255）
 * - GET /api/admin/town-tour/narration: ナレーションの設定。未保存なら読み上げない設定
 * - PUT /api/admin/town-tour/narration: ナレーションの設定を検証して保存する（問題があれば index.ts が問題点付きの400にする）
 *
 * 合成ページの素材（issue #229）が、レイドで引いた市町村のコードを渡して呼ぶ。Worker はコードから記事名を引き
 * （src/town-tour/articles.json）、Wikipedia の記事を材料に LLM に紹介を作らせ、出典の URL と一緒に返す。
 * 記事に出せる代表画像があれば、作者とライセンスと、LLM が書いた写真の説明（caption）も添えて返す（出せる画像が無ければ image は null。issue #254）。
 *
 * 紹介は貯めずにその都度作る。待ち時間は合成ページが日本地図の演出のあいだに吸収する（経緯は docs/decisions/town-tour.md）。
 * Twitch の Webhook の中で作らないのは、Free プランの waitUntil が30秒で打ち切られ、LLM の待ち時間の上限（60秒）に足りないためである。
 *
 * 一覧（towns.json）と記事名の表（articles.json）は src/town-tour/ にあり、合成ページと同じものを読む
 * （Worker から src/ を読み込む例外。.claude/rules/town-tour.md）。
 *
 * 注意: 失敗は空の紹介で取り繕わず 502 で返し、ダッシュボードの失敗の記録（collection_failures）にも残す（Fail-Fast）。
 * 注意: ナレーションの合成は、読み上げない設定なら 409 で断り、さくらは呼ばない（オーバーレイ用キーは配信画面に映りうるので、
 * 読み上げを選んでいない配信者に課金を起こさないため）。話者と速度は要求の本文ではなく保存済みの設定から取る。
 * 合成の失敗は合成ページが素材の箱に出してその場面だけ無音で流すので、失敗の記録には残さない（チャットの読み上げと同じ）。
 */
import articles from '../src/town-tour/articles.json'
import towns from '../src/town-tour/towns.json'
import { connectTownTourSocket, pushTownTour } from './alert-channel'
import { TOWN_TOUR_NARRATION_TEXT_MAX_LENGTH } from '../src/town-tour/narration'
import { listMedia } from './media'
import { loadOverlayKey } from './overlay-key'
import { HttpError, STATUS, requireAdmin, requireOverlayKey, type Context } from './http'
import { overlayKeyTag } from './overlay-key'
import { latestViewerCount, recordFailure } from './stats-store'
import { createSakuraTts } from './speech-sakura'
import { generateTownTour } from './town-tour'
import { loadTownTourNarration, parseTownTourNarration, saveTownTourNarration } from './town-tour-narration'
import { openTownTourQuiz } from './town-tour-quiz'
import { listTownTourVisits, recordTownTourVisit, type TownTourVisitOccasion } from './town-tour-visits'
import { pickTown, townTourCallOf } from './town-tour-call'
import { loadTownTourSound, parseTownTourSound, playbackSoundOf, saveTownTourSound } from './town-tour-sound'
import { fetchTownImage } from './town-image'
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
    // 写真の説明（imageCaption）を LLM に書かせる材料にするので、代表画像の情報を先に取る
    const image = article.image === null ? null : await fetchTownImage(context.fetch, article.image)
    const { imageCaption, ...tour } = await generateTownTour(context.llm, {
      prefecture: town.prefecture,
      county: town.county,
      name: town.name,
      material: pickTownMaterial(article.extract),
      image: article.image === null || image === null ? null : { fileName: article.image, description: image.description },
    })
    // Commons の説明は誰でも編集できるので画面には出さず、LLM が書いた写真の説明だけを返す
    const shownImage = image === null ? null : { url: image.url, artist: image.artist, license: image.license, caption: imageCaption }
    return Response.json({ ...town, article: { title: article.title, url: article.url }, tour, image: shownImage })
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

/**
 * POST /api/overlay/town-tour/quiz?key=: 合成ページがクイズの場面を流しはじめたときに、出題を開く。本文は { quizId, code }。
 *
 * 正解の都道府県は合成ページから受け取らず、一覧のコードから引く。開いてからクイズの長さ（と遅れの余裕）のあいだ、
 * Webhook が受けたチャットの発言を回答として照らす（webhook-routes.ts）。合成ページを2つ開いていて同じ出題が2回届いても、
 * 受け付ける長さは最初に開いたときから数える（town-tour-quiz.ts）。
 */
export const postTownTourQuiz = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  const body: unknown = await context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const isObject = typeof body === 'object' && body !== null
  const quizId = isObject && 'quizId' in body ? body.quizId : undefined
  const code = isObject && 'code' in body ? body.code : undefined
  if (typeof quizId !== 'string' || quizId === '' || typeof code !== 'string') {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文に出題の識別子（quizId）と市町村のコード（code）を入れてください')
  }
  const town = towns.find((candidate) => candidate.code === code)
  if (town === undefined) throw new HttpError(STATUS.notFound, 'unknown-town', `市町村の一覧に無いコードです: ${code}`)
  await openTownTourQuiz(context.env.DB, { id: quizId, code, prefecture: town.prefecture }, context.now)
  return new Response(null, { status: STATUS.noContent })
}

/** 記録するきっかけとして受け付けるもの（試し再生は記録しないので受け付けない） */
const VISIT_OCCASIONS: readonly string[] = ['raid', 'keyword'] satisfies TownTourVisitOccasion[]

const isVisitOccasion = (value: unknown): value is TownTourVisitOccasion => typeof value === 'string' && VISIT_OCCASIONS.includes(value)

/**
 * POST /api/overlay/town-tour/visit?key=: 合成ページが紹介を流しきったら（配信者への振りまで流したら）、紹介した市町村として記録する。
 * 本文は { code, occasion, userName }（呼び出しの visit に入れて押し出したもの）。
 *
 * 合成ページを2つ開いていて同じ紹介が2回届いても、記録は最初の1行のまま（town-tour-visits.ts）。
 *
 * 注意: 記録に失敗したら 502 で返し、ダッシュボードの失敗の記録（collection_failures）にも残す。合成ページは失敗を素材の箱に出すが、
 * 紹介（制覇マップ）は止めない（docs/decisions/town-tour.md）。
 */
export const postTownTourVisit = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  const body: unknown = await context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const isObject = typeof body === 'object' && body !== null
  const code = isObject && 'code' in body ? body.code : undefined
  const occasion = isObject && 'occasion' in body ? body.occasion : undefined
  const userName = isObject && 'userName' in body ? body.userName : undefined
  if (typeof code !== 'string' || !isVisitOccasion(occasion) || typeof userName !== 'string' || userName === '') {
    throw new HttpError(
      STATUS.badRequest,
      'invalid-body',
      '本文に市町村のコード（code）と、きっかけ（occasion。raid か keyword）と、相手の名前（userName）を入れてください',
    )
  }
  const town = towns.find((candidate) => candidate.code === code)
  if (town === undefined) throw new HttpError(STATUS.notFound, 'unknown-town', `市町村の一覧に無いコードです: ${code}`)

  try {
    await recordTownTourVisit(context.env.DB, { code, occasion, userName }, context.now)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // 記録の失敗を、失敗の記録の失敗で置き換えない。失敗の記録の失敗も黙って捨てず、応答の理由に添える
    const recordProblem = await recordFailure(
      context.env.DB,
      'town-tour-visit-failed',
      `紹介した市町村（${town.prefecture}${town.county}${town.name}）を記録できませんでした: ${reason}`,
      context.now,
    ).then(
      () => '',
      (recordError: unknown) => `（失敗の記録にも失敗しました: ${recordError instanceof Error ? recordError.message : String(recordError)}）`,
    )
    throw new HttpError(STATUS.badGateway, 'town-tour-visit-failed', `紹介した市町村を記録できませんでした: ${reason}${recordProblem}`)
  }
  return new Response(null, { status: STATUS.noContent })
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
 * 何を引いたかを画面に出せるよう、押し出したものを返す。音とナレーションもトリガーと同じく保存済みの設定で鳴らす（聞き比べられるように）。
 * 引くときはトリガーと同じく紹介済みの市町村を除き、制覇マップも出すが、試し再生そのものは記録しない（issue #252）。
 *
 * 注意: 配送先の失敗は黙って成功にせず 502 で返す（管理画面に理由を出す）。
 * 注意: 音を選んでいるのにオーバーレイ用キーが未発行なら、音のURLを作れないので押し出さずに 409 で返す（黙って無音で流さない）。
 */
export const postTownTourDemo = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { STORE } = context.env
  const [sound, narration, overlayKey, liveViewers, visited] = await Promise.all([
    loadTownTourSound(STORE),
    loadTownTourNarration(STORE),
    loadOverlayKey(STORE),
    latestViewerCount(context.env.DB),
    listTownTourVisits(context.env.DB),
  ])
  const playbackSound = ((): ReturnType<typeof playbackSoundOf> => {
    try {
      return playbackSoundOf(sound, overlayKey)
    } catch (error) {
      throw new HttpError(STATUS.conflict, 'overlay-key-missing', error instanceof Error ? error.message : String(error))
    }
  })()
  const call = townTourCallOf(
    pickTown(Math.random, new Set(visited)),
    { occasion: 'demo' },
    playbackSound,
    liveViewers,
    crypto.randomUUID(),
    visited,
    narration.enabled,
  )
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

/**
 * POST /api/overlay/town-tour/narration?key=: 合成ページが紹介の読み上げる文1件 { text } を、ナレーションの設定の話者と速度で
 * さくらのAI Engine に合成させ、WAV をそのまま返す（issue #255）。
 *
 * @throws HttpError 読み上げない設定（409）・APIキーが無い（400）・文が空か長すぎる（400）・さくらの失敗（502）
 */
export const postTownTourNarration = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  const narration = await loadTownTourNarration(context.env.STORE)
  if (!narration.enabled) {
    throw new HttpError(
      STATUS.conflict,
      'town-tour-narration-disabled',
      '市町村紹介のナレーションを読み上げない設定です。OBSでこのブラウザソースを再読み込みしてください',
    )
  }
  const apiKey = context.env.SAKURA_AI_API_KEY ?? ''
  if (apiKey === '') {
    throw new HttpError(
      STATUS.badRequest,
      'no-api-key',
      '市町村紹介のナレーションを読み上げる設定ですが、WorkerのシークレットSAKURA_AI_API_KEYが設定されていません',
    )
  }
  const body: unknown = await context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const text = typeof body === 'object' && body !== null && 'text' in body && typeof body.text === 'string' ? body.text : ''
  if (text.trim() === '' || [...text].length > TOWN_TOUR_NARRATION_TEXT_MAX_LENGTH) {
    throw new HttpError(STATUS.badRequest, 'invalid-text', `text は${TOWN_TOUR_NARRATION_TEXT_MAX_LENGTH}文字までの空でない文字列にしてください`)
  }
  const tts = createSakuraTts({ fetch: context.fetch, apiKey })
  const audio = await tts.synthesize(text, { speaker: narration.speaker, speed: narration.speed }).catch((error: unknown) => {
    throw new HttpError(STATUS.badGateway, 'town-tour-narration-failed', error instanceof Error ? error.message : String(error))
  })
  // さくらの合成が返すのは WAV（24kHz・モノラル）だけなので、種類はそのまま WAV として渡す
  return new Response(audio.body, { headers: { 'Content-Type': 'audio/wav' } })
}

/** GET /api/admin/town-tour/narration: ナレーションの設定。未保存なら読み上げない設定が返る */
export const getTownTourNarration = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json(await loadTownTourNarration(context.env.STORE))
}

/**
 * PUT /api/admin/town-tour/narration: ナレーションの設定を検証して保存し、保存したものを返す。
 *
 * @throws ConfigError 設定に問題がある場合（index.ts が問題点付きの400にする）
 */
export const putTownTourNarration = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body: unknown = await context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const narration = parseTownTourNarration(body)
  await saveTownTourNarration(context.env.STORE, narration)
  return Response.json(narration)
}
