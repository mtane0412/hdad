/**
 * オーバーレイ用の経路（OBSのブラウザソースから呼ばれる）
 *
 * どれもTwitchのトークンではなくオーバーレイ用キーで守る。素材だけは、管理画面でのプレビューのために配信者のセッションでも読める。
 */
import { connectAlertSocket } from './alert-channel'
import { HttpError, STATUS, hasSession, requireOverlayKey, type Context } from './http'
import { kindOfContentType } from './media'
import { readCurrentSideSuper } from './side-super-store'
import { recordTranscript } from './transcript-store'

/**
 * GET /api/overlay/socket?key=: オーバーレイからのWebSocketの接続を受け、配送先（Durable Object）へ引き渡す。
 *
 * Twitchからの通知はWebhookでWorkerに届くので、オーバーレイはTwitchへつながず、この接続で
 * 「再生するアラート」だけを受け取る。どのトリガーに当てはまるかの判定はWorkerが受け持つ。
 *
 * 注意: 接続を保持するのは Durable Object で、Workerはキーを確かめて引き渡すだけである。
 */
export const overlaySocket = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectAlertSocket(context.env.ALERTS, context.request)
}

/** 素材のIDはアップロードのたびに変わり、同じIDの中身は変わらないので、長くキャッシュさせる。キー付きのURLなので共有キャッシュには載せない */
const MEDIA_CACHE_CONTROL = 'private, max-age=31536000, immutable'
/**
 * 素材のURLを直接開かれたときに、素材（SVGなど）に仕込まれたスクリプトをこのサイトの権限で動かさないための指定。
 * img・video・audio の読み込みには影響しない。
 */
const MEDIA_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox"

/** GET /api/media/:id: 素材の中身を返す。オーバーレイ用キー（?key=）か、配信者のセッションが必要 */
export const media = async (context: Context): Promise<Response> => {
  if (!(await hasSession(context))) await requireOverlayKey(context)

  const id = context.params.id ?? ''
  const object = await context.env.MEDIA.get(id)
  const contentType = object?.httpMetadata?.contentType ?? ''
  if (!object || kindOfContentType(contentType) === null) {
    throw new HttpError(STATUS.notFound, 'media-not-found', `素材「${id}」が存在しません`)
  }
  return new Response(object.body, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(object.size),
      'Cache-Control': MEDIA_CACHE_CONTROL,
      'Content-Security-Policy': MEDIA_CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

/**
 * 1件の発話として受け付ける本文の長さの上限（文字数）。
 *
 * ゆかコネNEO が渡してくるのは確定した1文なので、これを超えるのは中継ページの誤りか、別のものが
 * 押し込まれているかである。長いものを黙って切り詰めず、拒む（Fail-Fast）。
 */
export const TRANSCRIPT_MAX_LENGTH = 1000

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * POST /api/overlay/transcript: 配信中の文字起こしを1件受け取る。
 *
 * OBSのブラウザソースに置いた中継ページ（transcript/index.html）が、同じPCで動いているゆかコネNEO の
 * 音声認識の結果のうち、確定した発話だけを押し込んでくる。あらすじ（issue #65）の材料になる。
 *
 * 配信していなければ記録せず、記録しなかったことを応答で知らせる（中継ページが画面に出せるように）。
 * 捨てるのを失敗にしないのは、配信の前後に中継ページを開いたままにしておくのが普通の使い方だからである。
 *
 * 注意: 同じ MsgID が二度届いても行は増えない（transcripts.message_id が主キー）。
 */
export const postTranscript = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  const { request, env, now } = context

  const body: unknown = await request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const messageId: unknown = isRecord(body) ? body.messageId : undefined
  if (typeof messageId !== 'string' || messageId === '') {
    throw new HttpError(STATUS.badRequest, 'invalid-message-id', 'messageId は空でない文字列にしてください（ゆかコネNEO の MsgID）')
  }
  const text: unknown = isRecord(body) ? body.text : undefined
  if (typeof text !== 'string') {
    throw new HttpError(STATUS.badRequest, 'invalid-text', 'text は空でない文字列にしてください')
  }
  // 空かどうかも長さも、実際に保存する形（前後の空白を落としたもの）で判定する
  const spoken = text.trim()
  if (spoken === '') {
    throw new HttpError(STATUS.badRequest, 'invalid-text', 'text は空でない文字列にしてください')
  }
  if (spoken.length > TRANSCRIPT_MAX_LENGTH) {
    throw new HttpError(STATUS.badRequest, 'text-too-long', `発話は${TRANSCRIPT_MAX_LENGTH}文字までにしてください`)
  }

  const recorded = await recordTranscript(env.DB, { messageId, text: spoken }, now)
  return Response.json({ recorded })
}

/**
 * GET /api/overlay/side-super: いま出すサイドスーパーの文言を返す。
 *
 * OBSのブラウザソースに置いたオーバーレイ（side-super/index.html）が定期的に読みに来る。
 * 文言は cron（worker/collect.ts）が5分おきに作って貯めてあるものをそのまま返すだけで、ここでLLMは呼ばない。
 *
 * 配信していない・まだ作っていないときは失敗にせず、空の行を返す（オーバーレイは何も映さない）。
 * 配信の前後にOBSを開いたままにするのが普通の使い方なので、文言が無いことは失敗ではない
 * （文字起こしの受け口が配信外の発話を捨てるのを失敗にしないのと同じ考え方）。
 */
export const getSideSuper = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  const sideSuper = await readCurrentSideSuper(context.env.DB, context.now)
  return Response.json({ lines: sideSuper?.lines ?? [], updatedAt: sideSuper?.updatedAt ?? null })
}
