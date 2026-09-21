/**
 * Webhook宛てのEventSub（配信の記録のためのイベント）
 *
 * アラート用オーバーレイはブラウザのWebSocketでイベントを受け取るが、それではオーバーレイを開いていない間のイベントを数えられない。
 * 配信の記録のためには、TwitchからWorkerへ直接届くWebhook宛ての購読を別に用意する。ここでは次の2つを受け持つ。
 * - 届いた通知の署名の検証（Twitchが送ったものであることの確認）
 * - Webhook宛ての購読を揃える処理（足りないものの登録、失効したものの登録し直し）
 *
 * 注意: Webhook宛ての購読はユーザートークンでは作れず、アプリアクセストークンが要る。
 * 配信者がこのアプリにスコープを認可済み（ログイン済み）であることが前提で、その場合は購読のコストを消費しない。
 */
import { EVENT_TYPES, byBroadcaster, withEventType, type EventType } from './eventsub'
import { signHex, timingSafeEqual } from './secret'
import type { EventSubSubscription, TwitchClient } from './twitch'

const SIGNATURE_PREFIX = 'sha256='

/** 件数を数えるイベント（サブスク・ポイント交換・レイド）。フォローはフォロワー数の推移として cron が記録するので数えない */
export const COUNTED_EVENT_TYPES: readonly string[] = [
  'channel.channel_points_custom_reward_redemption.add',
  'channel.subscribe',
  'channel.subscription.message',
  'channel.raid',
]

export const STREAM_ONLINE = 'stream.online'
export const STREAM_OFFLINE = 'stream.offline'

/** Webhookで受け取るイベント。件数を数えるものはオーバーレイと同じ定義を使い、配信の開始・終了（セッションを正確に記録するため）を足す */
const WEBHOOK_EVENTS: readonly EventType[] = [
  ...EVENT_TYPES.filter((eventType) => COUNTED_EVENT_TYPES.includes(eventType.type)),
  { type: STREAM_ONLINE, version: '1', scope: null, condition: byBroadcaster },
  { type: STREAM_OFFLINE, version: '1', scope: null, condition: byBroadcaster },
]

export const WEBHOOK_EVENT_TYPES: readonly string[] = WEBHOOK_EVENTS.map((eventType) => eventType.type)

/** そのまま使える購読の状態（有効・コールバックの確認待ち）。これ以外は失効しているので登録し直す */
const USABLE_STATUSES: readonly string[] = ['enabled', 'webhook_callback_verification_pending']

interface WebhookMessage {
  /** Twitch-Eventsub-Message-Id ヘッダー */
  messageId: string
  /** Twitch-Eventsub-Message-Timestamp ヘッダー（届いた文字列のまま） */
  timestamp: string
  /** リクエストの本文（届いた文字列のまま。JSONとして読み直したものでは署名が合わない） */
  body: string
  /** Twitch-Eventsub-Message-Signature ヘッダー（sha256=… の形） */
  signature: string
  secret: string
}

/** 通知の署名が「メッセージID＋タイムスタンプ＋本文」のHMAC-SHA256と一致するか */
export const verifyWebhookSignature = async ({ messageId, timestamp, body, signature, secret }: WebhookMessage): Promise<boolean> =>
  timingSafeEqual(signature, SIGNATURE_PREFIX + (await signHex(messageId + timestamp + body, secret)))

interface EnsureWebhookSubscriptionsOptions {
  twitch: Pick<TwitchClient, 'getAppAccessToken' | 'listSubscriptions' | 'deleteSubscription' | 'createSubscription'>
  broadcasterId: string
  /** 通知を受けるURL（https で、このWorkerの /api/eventsub/webhook） */
  callbackUrl: string
  /** 通知の署名に使うシークレット（EVENTSUB_SECRET） */
  secret: string
}

/**
 * Webhook宛ての購読を揃える。callbackUrl 宛てに有効な購読がないイベントだけを登録し、失効した購読は消してから登録し直す。
 * 別のURL宛ての購読（同じTwitchアプリを使う別の環境のもの）には触れない。
 *
 * @returns 新しく登録したイベントの種類
 * @throws TwitchApiError Twitchが失敗を返した（購読の登録なら、どのイベントかをメッセージに含む）
 */
export const ensureWebhookSubscriptions = async ({ twitch, broadcasterId, callbackUrl, secret }: EnsureWebhookSubscriptionsOptions): Promise<string[]> => {
  const accessToken = await twitch.getAppAccessToken()
  const registered = (await twitch.listSubscriptions(accessToken)).filter((subscription) => subscription.callback === callbackUrl)

  for (const subscription of registered.filter(({ status }) => !USABLE_STATUSES.includes(status))) {
    await twitch.deleteSubscription(accessToken, subscription.id)
  }

  const usableTypes = new Set(registered.filter(({ status }) => USABLE_STATUSES.includes(status)).map(({ type }) => type))
  const missing = WEBHOOK_EVENTS.filter(({ type }) => !usableTypes.has(type))
  for (const { type, version, condition } of missing) {
    const subscription: EventSubSubscription = {
      type,
      version,
      condition: condition(broadcasterId),
      transport: { method: 'webhook', callback: callbackUrl, secret },
    }
    await twitch.createSubscription(accessToken, subscription).catch((error: unknown) => {
      throw withEventType(error, type)
    })
  }
  return missing.map(({ type }) => type)
}
