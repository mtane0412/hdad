/**
 * EventSub WebSocketのメッセージの解釈
 *
 * Twitchから届くJSON（metadata と payload）を、接続の管理に使うもの（welcome・keepalive・reconnect・revocation）と
 * 通知（notification）に分けて取り出す。送受信は connection.ts、通知をアラートにする処理は trigger.ts が受け持つ。
 *
 * 注意: 知らない種類・形の崩れたメッセージは黙って無視せずエラーにする（Fail-Fast）。
 */

/** 通知（購読しているイベントが起きた） */
export interface EventSubNotification {
  readonly type: 'notification'
  /** メッセージID。Twitchは同じ通知を再送することがあるため、重複の判定に使う */
  readonly id: string
  /** イベントの種類（channel.follow など） */
  readonly subscriptionType: string
  /** イベントの中身。形はイベントの種類ごとに違う */
  readonly event: Readonly<Record<string, unknown>>
}

export type EventSubMessage =
  /** 接続直後に届く。sessionId を使って10秒以内に購読を登録する必要がある */
  | { readonly type: 'welcome'; readonly sessionId: string; readonly keepaliveTimeoutSeconds: number }
  /** イベントがない間も接続が生きていることを知らせる */
  | { readonly type: 'keepalive' }
  | EventSubNotification
  /** Twitch側の都合によるつなぎ直しの要求。url へつなぎ直せば購読は引き継がれる */
  | { readonly type: 'reconnect'; readonly url: string }
  /** 購読が取り消された（認可の取り消しなど） */
  | { readonly type: 'revocation'; readonly subscriptionType: string; readonly status: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** value[key] がオブジェクトならそれを、違えば空のオブジェクトを返す（続く項目の確認でまとめて弾くため） */
const recordAt = (value: Record<string, unknown>, key: string): Record<string, unknown> => {
  const child = value[key]
  return isRecord(child) ? child : {}
}

/**
 * WebSocketで届いた文字列を解釈する。
 *
 * @throws JSONでない・知らない種類・必要な項目が欠けている場合
 */
export const parseEventSubMessage = (text: string): EventSubMessage => {
  const message: unknown = JSON.parse(text)
  if (!isRecord(message)) throw new Error('EventSubのメッセージがオブジェクトではありません')

  const metadata = recordAt(message, 'metadata')
  const payload = recordAt(message, 'payload')
  const session = recordAt(payload, 'session')
  const subscription = recordAt(payload, 'subscription')
  const messageType = metadata.message_type
  const broken = new Error(`EventSubの ${String(messageType)} に必要な項目がありません`)

  switch (messageType) {
    case 'session_welcome':
      if (typeof session.id !== 'string' || typeof session.keepalive_timeout_seconds !== 'number') throw broken
      return { type: 'welcome', sessionId: session.id, keepaliveTimeoutSeconds: session.keepalive_timeout_seconds }
    case 'session_keepalive':
      return { type: 'keepalive' }
    case 'notification':
      if (typeof metadata.message_id !== 'string' || typeof subscription.type !== 'string' || !isRecord(payload.event)) throw broken
      return { type: 'notification', id: metadata.message_id, subscriptionType: subscription.type, event: payload.event }
    case 'session_reconnect':
      if (typeof session.reconnect_url !== 'string') throw broken
      return { type: 'reconnect', url: session.reconnect_url }
    case 'revocation':
      if (typeof subscription.type !== 'string' || typeof subscription.status !== 'string') throw broken
      return { type: 'revocation', subscriptionType: subscription.type, status: subscription.status }
    default:
      throw new Error(`EventSubの知らない種類のメッセージです: ${String(messageType)}`)
  }
}

/**
 * 「このメッセージIDは前にも見たか」を答える関数を作る。見ていなければ覚える。
 *
 * @param limit 覚えておく件数の上限。超えたら古いIDから忘れる（配信中ずっと増え続けないようにする）
 */
export const createSeenIds = (limit: number): ((id: string) => boolean) => {
  // Set は追加した順を保つので、先頭が最も古い
  const ids = new Set<string>()
  return (id) => {
    if (ids.has(id)) return true
    ids.add(id)
    if (ids.size > limit) {
      const oldest = ids.values().next().value
      if (oldest !== undefined) ids.delete(oldest)
    }
    return false
  }
}
