/**
 * オーバーレイ用の経路（OBSのブラウザソースから呼ばれる）
 *
 * どれもTwitchのトークンではなくオーバーレイ用キーで守る。素材だけは、管理画面でのプレビューのために配信者のセッションでも読める。
 */
import { loadAlertConfig } from './alert-config'
import { alertFor } from './alert-event'
import { resolveConditionState } from './alert-state'
import { readChatMessage } from './chat-command'
import { subscribeAll } from './eventsub'
import { HttpError, STATUS, hasSession, requireOverlayKey, type Context } from './http'
import { isValidOverlayKey } from './overlay-key'
import { kindOfContentType } from './media'

const CHAT_MESSAGE = 'channel.chat.message'

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

/**
 * POST /api/overlay/alert?key=: オーバーレイが受け取った通知に対して、再生するアラートを返す。
 *
 * 照合をオーバーレイではなくWorkerで行うのは、条件に「その配信で初めての発言か」のように
 * データベースの記録から決まるものがあり、オーバーレイでは判定できないためである。
 * オーバーレイは通知をそのまま送り、返ってきたアラートを再生するだけでよい。
 *
 * 注意: 通知の中身が想定と違えば、黙って捨てずに400で返す（Fail-Fast）。オーバーレイは画面にその理由を出す。
 */
export const overlayAlert = async (context: Context): Promise<Response> => {
  const key = await requireOverlayKey(context)

  const body: unknown = await context.request.json().catch(() => null)
  const { subscriptionType, event } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (typeof subscriptionType !== 'string' || typeof event !== 'object' || event === null) {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文は { "subscriptionType": string, "event": object } の形のJSONにしてください')
  }

  const config = await loadAlertConfig(context.env.STORE)
  const notification = (message: string): HttpError => new HttpError(STATUS.badRequest, 'invalid-notification', message)

  // 状態を持つ条件（その配信で初めての発言か）の判定に、発言の読み取りが要る。
  // 読み取るのはその条件を使うトリガーがあるときだけでよいが、読み取り自体は軽いので通知の種類だけで分ける
  const chatMessage = subscriptionType === CHAT_MESSAGE ? readChatMessage(event, notification) : null
  const state = await resolveConditionState(context.env.DB, config, chatMessage, context.now)

  const alert = ((): ReturnType<typeof alertFor> => {
    try {
      return alertFor(config, subscriptionType, event, key, state)
    } catch (error) {
      throw notification(error instanceof Error ? error.message : String(error))
    }
  })()

  // 管理画面での変更をすぐ反映させるため、キャッシュさせない
  return Response.json({ alert }, { headers: { 'Cache-Control': 'no-store' } })
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
