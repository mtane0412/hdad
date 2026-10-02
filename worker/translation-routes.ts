/**
 * 字幕の翻訳の経路（管理画面とアプリの枠から呼ばれる）
 *
 * - GET・PUT /api/admin/translation: 翻訳の提供元の設定（worker/translation-config.ts）。管理画面 /llm/ の「字幕の翻訳」の区画が使う
 * - GET /api/admin/translation/deepl-usage: DeepL の今月の使用量（無料枠の残りを出すため）
 * - POST /api/admin/translations: アプリの枠の音声認識が確定した1件を訳して返す（issue #191）
 *
 * 訳文はアプリの枠が受け取り、字幕の中継先へ送る（src/transcript/recognition-context.tsx）。中継先は中身を読まないままでいられる
 * （worker/draw-channel.ts）。確定した発話の記録（POST /api/admin/transcripts）とは経路を分けてある。記録は配信中しか行わず、
 * 送り直しもあるが、字幕の訳は配信の前の試しでも要り、遅い訳を待って記録の応答を遅らせたくないためである（docs/decisions/caption.md）。
 *
 * 注意: どれも配信者のセッションで守る。訳すたびに料金や無料枠を使うので、オーバーレイ用キーでは呼ばせない。
 */
import { HttpError, STATUS, requireAdmin, type Context } from './http'
import { recordFailure } from './stats-store'
import { createTranslator, readDeeplUsage, type TranslationRequest } from './translation'
import { loadTranslationSettings, parseTranslationSettings, saveTranslationSettings } from './translation-config'

/**
 * 訳す1件の長さの上限（文字数）。確定した発話の記録の上限（worker/transcript-routes.ts の TRANSCRIPT_MAX_LENGTH）に合わせる。
 * 文脈として添える直前の発話にも同じ上限を使う。
 */
export const TRANSLATION_MAX_LENGTH = 1000

/** 文脈として受け付ける直前の発話の数（issue #191 で直前の2件と決めた） */
export const TRANSLATION_CONTEXT_LINES = 2

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isLine = (value: unknown): value is string => typeof value === 'string' && value.length <= TRANSLATION_MAX_LENGTH

/** 本文 { text, context } を読む。読めなければ400にする（長いものを黙って切り詰めない） */
const readTranslationRequest = async (request: Request): Promise<TranslationRequest> => {
  const body: unknown = await request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const text = isRecord(body) && typeof body.text === 'string' ? body.text.trim() : ''
  if (text === '' || text.length > TRANSLATION_MAX_LENGTH) {
    throw new HttpError(STATUS.badRequest, 'invalid-text', `text は${TRANSLATION_MAX_LENGTH}文字までの空でない文字列にしてください`)
  }
  const context: unknown = isRecord(body) ? body.context : undefined
  if (!Array.isArray(context) || context.length > TRANSLATION_CONTEXT_LINES || !context.every(isLine)) {
    throw new HttpError(
      STATUS.badRequest,
      'invalid-context',
      `context は直前の発話（${TRANSLATION_MAX_LENGTH}文字までの文字列）を${TRANSLATION_CONTEXT_LINES}件までの配列にしてください`,
    )
  }
  return { text, context }
}

/**
 * GET /api/admin/translation: 翻訳の提供元の設定。未保存なら「訳さない」が返る。
 *
 * DeepL の鍵は応答に含めず、設定されているかどうかだけを添える（OpenRouter の鍵と同じ扱い）。
 */
export const getTranslation = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const settings = await loadTranslationSettings(context.env.STORE)
  return Response.json({ ...settings, deeplKeyConfigured: (context.env.DEEPL_API_KEY ?? '') !== '' })
}

/**
 * PUT /api/admin/translation: 翻訳の提供元の設定を検証して保存する。
 *
 * @throws ConfigError 知らない提供元の場合（index.ts が問題点付きの400にする）
 */
export const putTranslation = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body: unknown = await context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const settings = parseTranslationSettings(body)
  await saveTranslationSettings(context.env.STORE, settings)
  return Response.json(settings)
}

/**
 * GET /api/admin/translation/deepl-usage: DeepL の今月の使用量。
 *
 * @throws HttpError 鍵が設定されていない場合（400。問い合わせる先が無いので、0 を返さずに断る）
 * @throws Error DeepL から使用量を取れなかった場合（index.ts が500にする）
 */
export const getDeeplUsage = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const apiKey = context.env.DEEPL_API_KEY ?? ''
  if (apiKey === '') {
    throw new HttpError(STATUS.badRequest, 'no-api-key', 'DeepL のAPIキー（WorkerのシークレットDEEPL_API_KEY）が設定されていないため、使用量を読めません')
  }
  return Response.json(await readDeeplUsage({ fetch: context.fetch, apiKey }))
}

/**
 * POST /api/admin/translations: 確定した1件を設定どおりに訳し、{ translation } で答える（訳さない設定なら null）。
 *
 * 訳せなかったら 502 で理由を返し、ダッシュボードの失敗の記録（collection_failures）にも残す。
 * アプリの枠は原文の字幕を止めず、理由をコネクターのページに出す。
 */
export const postTranslation = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const request = await readTranslationRequest(context.request)
  const translator = createTranslator({
    store: context.env.STORE,
    llm: context.llm,
    ai: context.env.AI,
    fetch: context.fetch,
    deeplApiKey: context.env.DEEPL_API_KEY,
    db: context.env.DB,
    now: () => context.now,
  })
  try {
    return Response.json({ translation: await translator.translate(request) })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await recordFailure(context.env.DB, 'translation-failed', `字幕の翻訳に失敗しました: ${reason}`, context.now)
    // 応答には理由だけを載せる（「翻訳に失敗した」ことはアプリの枠が言い添える）
    throw new HttpError(STATUS.badGateway, 'translation-failed', reason)
  }
}
