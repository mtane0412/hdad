/**
 * オーバーレイ用の経路（OBSのブラウザソースから呼ばれる）
 *
 * どれもTwitchのトークンではなくオーバーレイ用キーで守る。素材だけは、管理画面でのプレビューのために配信者のセッションでも読める。
 */
import { loadAlertConfig, toOverlayConfig } from './alert-config'
import { subscribeAll } from './eventsub'
import { HttpError, STATUS, hasSession, requireOverlayKey, type Context } from './http'
import { isValidOverlayKey } from './overlay-key'
import { kindOfContentType } from './media'

/** 素材のIDはアップロードのたびに変わり、同じIDの中身は変わらないので、長くキャッシュさせる。キー付きのURLなので共有キャッシュには載せない */
const MEDIA_CACHE_CONTROL = 'private, max-age=31536000, immutable'
/**
 * 素材のURLを直接開かれたときに、素材（SVGなど）に仕込まれたスクリプトをこのサイトの権限で動かさないための指定。
 * img・video・audio の読み込みには影響しない。
 */
const MEDIA_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox"

/** POST /api/eventsub/subscriptions: EventSubのセッションに対する購読を、保管しているトークンで登録する */
export const subscribe = async ({ request, env, twitch, now }: Context): Promise<Response> => {
  const body: unknown = await request.json().catch(() => null)
  const { key, sessionId } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (typeof key !== 'string' || typeof sessionId !== 'string' || sessionId === '') {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文は { "key": string, "sessionId": string } の形のJSONにしてください')
  }
  if (!(await isValidOverlayKey(env.STORE, key))) {
    throw new HttpError(STATUS.unauthorized, 'invalid-overlay-key', 'オーバーレイ用キーが正しくありません。管理画面のURLを貼り直してください')
  }

  const types = await subscribeAll({ store: env.STORE, twitch, broadcasterId: env.TWITCH_BROADCASTER_ID, sessionId, now })
  return Response.json({ types })
}

/** GET /api/overlay/config?key=: アラートの設定を、素材のURL付きで返す */
export const overlayConfig = async (context: Context): Promise<Response> => {
  const key = await requireOverlayKey(context)
  const config = await loadAlertConfig(context.env.STORE)
  // 管理画面での変更をすぐ反映させるため、キャッシュさせない
  return Response.json(toOverlayConfig(config, key), { headers: { 'Cache-Control': 'no-store' } })
}

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
