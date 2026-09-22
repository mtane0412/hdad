/**
 * オーバーレイ用の経路（OBSのブラウザソースから呼ばれる）
 *
 * どれもTwitchのトークンではなくオーバーレイ用キーで守る。素材だけは、管理画面でのプレビューのために配信者のセッションでも読める。
 */
import { connectAlertSocket } from './alert-channel'
import { HttpError, STATUS, hasSession, requireOverlayKey, type Context } from './http'
import { kindOfContentType } from './media'

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
