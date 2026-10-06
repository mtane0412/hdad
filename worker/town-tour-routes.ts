/**
 * 市町村紹介の経路
 *
 * - GET /api/overlay/town-tour?key=&code=[&raider=&viewers=]: コードの市町村の紹介を作って返す。レイド元が添えられていれば、その配信者との共通点も作る（issue #275）
 * - POST /api/overlay/town-tour/quiz?key=: 合成ページが冒頭の都道府県当てクイズを流しはじめたときに、出題を開く（issue #251）
 * - POST /api/overlay/town-tour/visit?key=: 合成ページが紹介を流しきったら、紹介した市町村として記録する（issue #252）
 * - GET /api/overlay/town-tour/socket?key=: 合成ページの素材「市町村紹介」の WebSocket の接続を配送先（AlertChannel）へ引き渡す
 * - POST /api/admin/town-tour/demo: 管理画面の試し再生。市町村を1つ引いて素材へ押し出す（トリガーと同じ配送の経路を通す）。
 *   本文に { userName } があれば、そのログイン名の配信者をレイド元とみなす（issue #275）
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
 * 共通点（worker/town-bond.ts）は、紹介と並べて作り、揃えて返す。レイド元の Twitch の公開情報はここで引く（Webhook の中で Twitch を呼ばない約束）。
 * 共通点だけの失敗では紹介を止めず、共通点を null にして理由（bondFailure）を添え、失敗の記録（town-tour-bond-failed）に残す。
 * 合成ページは理由を素材の箱に出し、共通点の代わりに振りを出す。OpenRouter の鍵が無い配信者には共通点を出さない（失敗ではなく決めた形）。
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
import { loadLlmSettings } from './llm-config'
import { latestViewerCount, recordFailure } from './stats-store'
import { createSakuraTts } from './speech-sakura'
import { generateTownTour } from './town-tour'
import { generateTownBond } from './town-bond'
import { loadTownTourNarration, parseTownTourNarration, saveTownTourNarration } from './town-tour-narration'
import { openTownTourQuiz } from './town-tour-quiz'
import { listTownTourVisits, recordTownTourVisit, type TownTourVisitOccasion } from './town-tour-visits'
import { pickTown, townTourCallOf } from './town-tour-call'
import { loadTownTourSound, parseTownTourSound, playbackSoundOf, saveTownTourSound } from './town-tour-sound'
import { fetchTownImage } from './town-image'
import { fetchTownArticle, pickTownMaterial, type TownMaterial } from './town-wikipedia'

/** コードから記事名を引く表。JSON のキーは文字列なので Map に移しておき、プロトタイプのキー（toString など）に当たらないようにする */
const articleTitles: ReadonlyMap<string, string> = new Map(Object.entries(articles))

/** Twitch のログイン名の形（英数字とアンダースコアの25文字まで）。外へ問い合わせる前に、打ち間違いや細工した値を断る */
const TWITCH_LOGIN_PATTERN = /^[A-Za-z0-9_]{1,25}$/
/** 連れてきた人数の形（0以上の整数） */
const VIEWERS_PATTERN = /^\d{1,9}$/

/** 共通点を作らせるレイド元（GET の raider と viewers） */
interface RaiderQuery {
  readonly login: string
  readonly viewers: number | null
}

/**
 * GET のクエリから、共通点を作らせるレイド元を読む。添えられていなければ null。
 *
 * @throws HttpError ログイン名か人数の形が違う・人数だけが添えられているとき（400）
 */
const readRaiderQuery = (params: URLSearchParams): RaiderQuery | null => {
  const login = params.get('raider')
  const viewers = params.get('viewers')
  if (login === null) {
    if (viewers !== null) throw new HttpError(STATUS.badRequest, 'invalid-raider', '連れてきた人数（viewers）は、レイド元（raider）と一緒に添えてください')
    return null
  }
  if (!TWITCH_LOGIN_PATTERN.test(login) || (viewers !== null && !VIEWERS_PATTERN.test(viewers))) {
    throw new HttpError(STATUS.badRequest, 'invalid-raider', 'レイド元（raider）は Twitch のログイン名、連れてきた人数（viewers）は0以上の整数で添えてください')
  }
  return { login, viewers: viewers === null ? null : Number(viewers) }
}

/** 合成ページへ返す共通点（worker/town-bond.ts の TownBond に、画面に出すレイド元の名前とアイコンを添えたもの） */
interface ShownTownBond {
  readonly raiderName: string
  readonly raiderIcon: string
  readonly raiderQuote: string
  readonly townQuote: string
  readonly text: string
  readonly certificateReason: string
}

/**
 * レイド元との共通点を作る。失敗しても投げず、理由を失敗の記録に残して bondFailure に入れる（紹介は止めない）。
 *
 * OpenRouter の鍵が無く、共通点の提供元が OpenRouter のまま（既定）なら、Twitch も LLM も呼ばずに共通点なしにする（配信者が決めた）。
 */
const townBondFor = async (
  context: Context,
  town: { prefecture: string; county: string; name: string },
  material: TownMaterial,
  raider: RaiderQuery,
): Promise<{ bond: ShownTownBond | null; bondFailure: string | null }> => {
  const { env, twitch } = context
  try {
    const settings = await loadLlmSettings(env.STORE)
    if (settings.usages.townBond.provider === 'openrouter' && (env.OPENROUTER_API_KEY ?? '') === '') return { bond: null, bondFailure: null }
    const accessToken = await twitch.getAppAccessToken()
    const user = await twitch.getUserByLogin(accessToken, raider.login)
    if (user === null) throw new Error(`Twitch にログイン名 ${raider.login} の配信者がいません`)
    const channel = await twitch.getChannelDetail(accessToken, user.id)
    const bond = await generateTownBond(context.llm, {
      ...town,
      material,
      raider: {
        displayName: user.displayName,
        login: user.login,
        description: user.description,
        category: channel.categoryName,
        title: channel.title,
        tags: channel.tags,
        viewers: raider.viewers,
      },
    })
    return {
      bond: {
        raiderName: user.displayName,
        raiderIcon: user.profileImageUrl,
        raiderQuote: bond.raiderQuote,
        townQuote: bond.townQuote,
        text: bond.bond,
        certificateReason: bond.certificateReason,
      },
      bondFailure: null,
    }
  } catch (error) {
    const reason = `${town.prefecture}${town.county}${town.name}と ${raider.login} さんの共通点を作れませんでした: ${error instanceof Error ? error.message : String(error)}`
    // 記録に失敗しても、共通点を作れなかった理由を記録の失敗で置き換えない。記録の失敗も黙って捨てず、理由に添える
    const recordProblem = await recordFailure(env.DB, 'town-tour-bond-failed', reason, context.now).then(
      () => '',
      (recordError: unknown) => `（失敗の記録にも失敗しました: ${recordError instanceof Error ? recordError.message : String(recordError)}）`,
    )
    return { bond: null, bondFailure: `${reason}${recordProblem}` }
  }
}

/** GET /api/overlay/town-tour?key=&code=: コードの市町村の紹介を作って返す */
export const getTownTour = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  const code = context.url.searchParams.get('code') ?? ''
  const town = towns.find((candidate) => candidate.code === code)
  const title = articleTitles.get(code)
  if (town === undefined || title === undefined) {
    throw new HttpError(STATUS.notFound, 'unknown-town', `市町村の一覧に無いコードです: ${code}`)
  }
  const raider = readRaiderQuery(context.url.searchParams)

  try {
    const article = await fetchTownArticle(context.fetch, title)
    const material = pickTownMaterial(article.extract)
    /** 紹介を作る。写真の説明（imageCaption）を LLM に書かせる材料にするので、代表画像の情報を先に取る */
    const introduce = async () => {
      const image = article.image === null ? null : await fetchTownImage(context.fetch, article.image)
      const tour = await generateTownTour(context.llm, {
        prefecture: town.prefecture,
        county: town.county,
        name: town.name,
        material,
        image: article.image === null || image === null ? null : { fileName: article.image, description: image.description },
      })
      return { image, tour }
    }
    // 共通点は紹介とは別の呼び出しにし（同じ呼び出しでは紹介が薄くなった）、待ち時間を重ねないよう並べて作る。共通点の失敗は投げない
    const [{ image, tour: generated }, { bond, bondFailure }] = await Promise.all([
      introduce(),
      raider === null ? { bond: null, bondFailure: null } : townBondFor(context, town, material, raider),
    ])
    const { imageCaption, ...tour } = generated
    // Commons の説明は誰でも編集できるので画面には出さず、LLM が書いた写真の説明だけを返す
    const shownImage = image === null ? null : { url: image.url, artist: image.artist, license: image.license, caption: imageCaption }
    return Response.json({ ...town, article: { title: article.title, url: article.url }, tour, image: shownImage, bond, bondFailure })
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
 * 試し再生の本文から、レイド元とみなす配信者を読む。本文が空か、ユーザー名が空なら null（見本の名前で流す）。
 * 打ち間違いに気づけるよう、Twitch にいるかをここで確かめ、表示名を引く。
 *
 * @throws HttpError 本文が JSON でない・ユーザー名がログイン名の形でない（400）・そのログイン名の配信者がいない（404）・Twitch の失敗（502）
 */
const readDemoRaider = async (context: Context): Promise<{ userName: string; userLogin: string } | null> => {
  const text = await context.request.text()
  if (text.trim() === '') return null
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  }
  const userName = typeof body === 'object' && body !== null && 'userName' in body ? body.userName : undefined
  if (userName === undefined || userName === '') return null
  if (typeof userName !== 'string' || !TWITCH_LOGIN_PATTERN.test(userName)) {
    throw new HttpError(STATUS.badRequest, 'invalid-user-name', 'レイド元とみなすユーザー名は、Twitch のログイン名（英数字とアンダースコア）で入れてください')
  }
  const user = await (async () => {
    try {
      return await context.twitch.getUserByLogin(await context.twitch.getAppAccessToken(), userName)
    } catch (error) {
      throw new HttpError(STATUS.badGateway, 'twitch-user-failed', `Twitch から ${userName} を引けませんでした: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()
  if (user === null) throw new HttpError(STATUS.notFound, 'unknown-twitch-user', `Twitch にログイン名 ${userName} の配信者がいません`)
  return { userName: user.displayName, userLogin: user.login }
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
  const raider = await readDemoRaider(context)
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
    { occasion: 'demo', raider },
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
