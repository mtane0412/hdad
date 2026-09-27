/**
 * 管理用の経路（/api/admin/*）
 *
 * 配信者のセッションが必要。アラートの設定の取得と保存、素材の一覧・アップロード・削除、オーバーレイ用キーの再発行、
 * トリガーの設定で選ぶチャンネルポイント報酬の一覧、チャットの読み上げの設定の取得と保存、
 * 合成オーバーレイの構成（どのオーバーレイにどの素材を置くか）の取得と保存、LLMの設定とその使用状況を受け持つ。
 */
import { alertActionOf, loadAlertConfig, parseAlertConfig, saveAlertConfig } from './alert-config'
import { HttpError, STATUS, requireAdmin, type Context } from './http'
import { listMedia, uploadMedia } from './media'
import { rotateOverlayKey } from './overlay-key'
import { loadOverlayLayout, parseOverlayLayout, saveOverlayLayout } from './overlay-layout'
import { LLM_PROVIDERS, loadLlmSettings, parseLlmSettings, saveLlmSettings, type LlmProvider } from './llm-config'
import { readOpenRouterCredits } from './llm-credits'
import { listLlmModels } from './llm-models'
import { listLlmUsage, toUtcDay } from './llm-usage-store'
import { loadSpeechSettings, parseSpeechSettings, saveSpeechSettings } from './speech-config'
import { getAccessToken } from './token'

/** GET /api/admin/config */
export const getConfig = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json(await loadAlertConfig(context.env.STORE))
}

/**
 * PUT /api/admin/config: 設定を検証して保存する。
 *
 * @throws ConfigError 設定に問題がある場合（index.ts が問題点付きの400にする）
 */
export const putConfig = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { request, env } = context
  const body: unknown = await request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })

  const kinds = new Map((await listMedia(env.MEDIA)).map((item) => [item.id, item.kind]))
  const config = parseAlertConfig(body, (mediaId) => kinds.get(mediaId) ?? null)
  await saveAlertConfig(env.STORE, config)
  return Response.json(config)
}

/** GET /api/admin/media */
export const getMedia = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json({ media: await listMedia(context.env.MEDIA) })
}

/** POST /api/admin/media */
export const postMedia = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json(await uploadMedia(context.env.MEDIA, context.request), { status: STATUS.created })
}

/** DELETE /api/admin/media/:id: トリガーに使われている素材は消させない（配信中にアラートが出なくなるのを防ぐ） */
export const deleteMedia = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { env, params } = context
  const id = params.id ?? ''

  if ((await env.MEDIA.head(id)) === null) throw new HttpError(STATUS.notFound, 'media-not-found', `素材「${id}」が存在しません`)
  const { triggers } = await loadAlertConfig(env.STORE)
  if (triggers.some((trigger) => alertActionOf(trigger)?.mediaId === id)) {
    throw new HttpError(STATUS.conflict, 'media-in-use', 'この素材はトリガーに使われています。先にトリガーの設定から外してください')
  }

  await env.MEDIA.delete(id)
  return new Response(null, { status: STATUS.noContent })
}

/** POST /api/admin/overlay-key: オーバーレイ用キーを発行し直す */
export const postOverlayKey = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json({ overlayKey: await rotateOverlayKey(context.env.STORE) })
}

/**
 * GET /api/admin/rewards: 配信者のチャンネルポイント報酬の一覧。トークンは応答に含めない。
 *
 * @throws AuthError トークンが保管されていない・更新できない
 * @throws TwitchApiError Twitchが失敗を返した（チャンネルポイントを使えないチャンネルなど）
 */
export const getRewards = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { env, twitch, now } = context
  const token = await getAccessToken(env.STORE, 'broadcaster', twitch, now)
  return Response.json({ rewards: await twitch.listCustomRewards(token.accessToken, env.TWITCH_BROADCASTER_ID) })
}

/** GET /api/admin/speech: チャットの読み上げの設定。未保存なら既定の設定が返る */
export const getSpeech = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json(await loadSpeechSettings(context.env.STORE))
}

/**
 * PUT /api/admin/speech: チャットの読み上げの設定を検証して保存する。
 *
 * 検証は Worker だけが持ち、画面とWorkerで二重に持たない（issue #86）。
 *
 * @throws ConfigError 設定に問題がある場合（index.ts が問題点付きの400にする）
 */
export const putSpeech = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body: unknown = await context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const settings = parseSpeechSettings(body)
  await saveSpeechSettings(context.env.STORE, settings)
  return Response.json(settings)
}

/**
 * GET /api/admin/overlay/layout: 合成オーバーレイの構成。未保存ならオーバーレイが1つもない構成が返る。
 *
 * 合成ページ側の読み出しは overlay-routes.ts にある（守り方がセッションではなくオーバーレイ用キーなので、
 * 置き場所も分けてある。注目コメントと同じ）。
 */
export const getOverlayLayout = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json(await loadOverlayLayout(context.env.STORE))
}

/**
 * PUT /api/admin/overlay/layout: 合成オーバーレイの構成を検証して保存する。
 *
 * 素材のパラメータはクエリ文字列のまま預かり、中身は検証しない（素材のスキーマは src/ にあり、
 * Worker からは読み込めない。worker/overlay-layout.ts）。
 *
 * @throws ConfigError 構成に問題がある場合（index.ts が問題点付きの400にする）
 */
export const putOverlayLayout = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body: unknown = await context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const layout = parseOverlayLayout(body)
  await saveOverlayLayout(context.env.STORE, layout)
  return Response.json(layout)
}

/**
 * GET /api/admin/llm: LLMの設定（提供元と用途ごとのモデル名）。未保存なら既定の設定が返る。
 *
 * OpenRouter のAPIキーは応答に含めず、設定されているかどうかだけを添える（Twitchのトークンと同じ扱い）。
 * 提供元に OpenRouter を選んでいるのに鍵が無ければ呼び出しが失敗するので、画面がそれを先に知らせられるようにする。
 */
export const getLlm = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const settings = await loadLlmSettings(context.env.STORE)
  return Response.json({ ...settings, apiKeyConfigured: (context.env.OPENROUTER_API_KEY ?? '') !== '' })
}

/**
 * PUT /api/admin/llm: LLMの設定を検証して保存する。
 *
 * 検証は Worker だけが持ち、画面とWorkerで二重に持たない（読み上げの設定と同じ）。
 *
 * @throws ConfigError 設定に問題がある場合（index.ts が問題点付きの400にする）
 */
export const putLlm = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body: unknown = await context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const settings = parseLlmSettings(body)
  await saveLlmSettings(context.env.STORE, settings)
  return Response.json(settings)
}

/** 使用状況として返す期間（日）。1か月ぶんあれば、無料枠の使い具合と月ごとの増減が読める */
const USAGE_WINDOW_DAYS = 30

/**
 * GET /api/admin/llm/usage: LLMを呼んだ回数・トークン数・実費の、日ごとのまとめ。
 *
 * 記録しているのは worker/llm.ts（LLMへの唯一の入口）で、日の区切りは UTC である
 * （Workers AI の無料枠が UTC の日で切り替わるため。worker/llm-usage-store.ts）。
 * まとめ方（今日・直近7日）は画面（src/llm/usage.ts）が行うので、ここでは日ごとの行をそのまま返す。
 */
export const getLlmUsage = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const since = toUtcDay(context.now - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  return Response.json({ days: await listLlmUsage(context.env.DB, since) })
}

/**
 * GET /api/admin/llm/credits: OpenRouter の残高（付与額・使用額・残り）。
 *
 * 使用状況（llm_usage）と分けてあるのは、Workers AI には対応するものが無く、片方の失敗をもう片方に
 * 波及させないためである（モデルの一覧を提供元ごとに分けて読むのと同じ考え方）。
 *
 * @throws HttpError 鍵が設定されていない場合（400。問い合わせる先が無いので、0 を返さずに断る）
 * @throws Error OpenRouter から残高を取れなかった場合（index.ts が500にする）
 */
export const getLlmCredits = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const apiKey = context.env.OPENROUTER_API_KEY ?? ''
  if (apiKey === '') {
    throw new HttpError(
      STATUS.badRequest,
      'no-api-key',
      'OpenRouter のAPIキー（WorkerのシークレットOPENROUTER_API_KEY）が設定されていないため、残高を読めません',
    )
  }
  return Response.json(await readOpenRouterCredits({ fetch: context.fetch, apiKey }))
}

/**
 * GET /api/admin/llm/models?provider=…: その提供元で選べるモデルの一覧。
 *
 * 管理画面のモデルの選択欄に出す候補で、Workers AI はこのリポジトリが持つ一覧、OpenRouter は公開API
 * （鍵は要らない）から取る（worker/llm-models.ts）。提供元ごとに分けてあるのは、使っていない提供元の
 * 一覧を取りに行かずに済ませるためと、OpenRouter を取れなかったことが Workers AI の選択欄に波及しないようにするためである。
 *
 * @throws HttpError 提供元の指定が無い・知らない名前の場合（400）
 * @throws Error OpenRouter から一覧を取れなかった場合（index.ts が500にする。黙って空の一覧を返さない）
 */
export const getLlmModels = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const provider = context.url.searchParams.get('provider')
  if (!LLM_PROVIDERS.includes(provider as LlmProvider)) {
    throw new HttpError(STATUS.badRequest, 'invalid-provider', `provider は ${LLM_PROVIDERS.join(' か ')} で指定してください`)
  }
  const models = await listLlmModels(provider as LlmProvider, { fetch: context.fetch, store: context.env.STORE, now: context.now })
  return Response.json({ models })
}
