/**
 * Webhook宛てのEventSub（配信の記録のためのイベント）
 *
 * Twitchからの通知は、すべてこのWebhook宛ての購読でWorkerが受け取る（オーバーレイはTwitchへ直接つながない）。
 * オーバーレイを開いていない間のイベントも数えられ、同じイベントが2回届くこともない。ここでは次の2つを受け持つ。
 * - 届いた通知の署名の検証（Twitchが送ったものであることの確認）
 * - Webhook宛ての購読を揃える処理（足りないものの登録、失効したものの登録し直し）
 *
 * 注意: Webhook宛ての購読はユーザートークンでは作れず、アプリアクセストークンが要る。
 * 配信者がこのアプリにスコープを認可済み（ログイン済み）であることが前提で、その場合は購読のコストを消費しない。
 * チャット（channel.chat.message）の購読の条件にある「チャットを読む人」には配信者自身を指定する。
 * botを指定していた頃はbotの接続・切断のたびに購読を揃え直す必要があったが、配信者に固定したことでbotと無関係になった。
 */
import { EVENT_TYPES, byBroadcaster, withEventType, type EventType } from './eventsub'
import type { Context } from './http'
import { signHex, timingSafeEqual } from './secret'
import { recordFailure } from './stats-store'
import { TwitchApiError, type EventSubSubscription, type RegisteredSubscription, type TwitchClient } from './twitch'
import { WEBHOOK_PATH } from './webhook-routes'

const SIGNATURE_PREFIX = 'sha256='

/** 件数を数えるイベント（サブスク・ポイント交換・レイド）。フォローはフォロワー数の推移として cron が記録するので数えない */
export const COUNTED_EVENT_TYPES: readonly string[] = [
  'channel.channel_points_custom_reward_redemption.add',
  'channel.subscribe',
  'channel.subscription.message',
  'channel.raid',
]

/**
 * 件数は数えないが、アラートのトリガー（チャットへのお礼・自動モデレーション・コマンドの応答）のために購読するイベント。
 *
 * フォローはフォロワー数の推移として cron が記録するので数えないが、オーバーレイを開いていなくても
 * Workerがお礼を送れるように、Webhookでも受け取る。購読に要る moderator:read:followers は
 * 配信者が既に認可済み（eventsub.ts の EVENT_TYPES 由来）なので、ログインし直す必要はない。
 *
 * チャットの発言（channel.chat.message）も、条件は eventsub.ts の EVENT_TYPES と同じものを使う。
 * つまり「チャットを読む人」は配信者自身である。
 */
export const STREAM_ONLINE = 'stream.online'
export const STREAM_OFFLINE = 'stream.offline'
export const CHAT_MESSAGE = 'channel.chat.message'

export const UNCOUNTED_EVENT_TYPES: readonly string[] = ['channel.follow', CHAT_MESSAGE]

/** 購読を1つ登録するのに要る内容（条件は解決済み） */
interface WantedEvent {
  type: string
  version: string
  condition: Record<string, string>
}

/**
 * Webhookで受け取るイベントを組み立てる。
 *
 * 件数を数えるものとチャットはオーバーレイと同じ定義（eventsub.ts の EVENT_TYPES）を使い、
 * 配信の開始・終了（セッションを正確に記録するため）を足す。
 */
const buildWantedEvents = (broadcasterId: string): WantedEvent[] => {
  const base: readonly EventType[] = [
    ...EVENT_TYPES.filter((eventType) => COUNTED_EVENT_TYPES.includes(eventType.type) || UNCOUNTED_EVENT_TYPES.includes(eventType.type)),
    { type: STREAM_ONLINE, version: '1', scope: null, condition: byBroadcaster },
    { type: STREAM_OFFLINE, version: '1', scope: null, condition: byBroadcaster },
  ]
  return base.map(({ type, version, condition }) => ({ type, version, condition: condition(broadcasterId) }))
}

/** Webhookで受け取るイベントの種類 */
export const webhookEventTypes = (): string[] =>
  buildWantedEvents('（種類を数えるだけなので配信者IDは使わない）').map((event) => event.type)

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

const isSameCondition = (left: Record<string, string>, right: Record<string, string>): boolean => {
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}

interface EnsureWebhookSubscriptionsOptions {
  twitch: Pick<TwitchClient, 'getAppAccessToken' | 'listSubscriptions' | 'deleteSubscription' | 'createSubscription'>
  broadcasterId: string
  /** 通知を受けるURL（https で、このWorkerの /api/eventsub/webhook） */
  callbackUrl: string
  /** 通知の署名に使うシークレット（EVENTSUB_SECRET） */
  secret: string
}

/**
 * Webhook宛ての購読を揃える。callbackUrl 宛てに有効な購読（種類・バージョン・条件が一致するもの）がないイベントだけを登録し、
 * 失効した購読と内容が合わない購読は消してから登録し直す。
 * 別のURL宛ての購読（同じTwitchアプリを使う別の環境のもの）には触れない。
 *
 * @returns 新しく登録したイベントの種類
 * @throws TwitchApiError Twitchが失敗を返した（購読の登録なら、どのイベントかをメッセージに含む）
 */
export const ensureWebhookSubscriptions = async ({ twitch, broadcasterId, callbackUrl, secret }: EnsureWebhookSubscriptionsOptions): Promise<string[]> => {
  const accessToken = await twitch.getAppAccessToken()
  const registered = (await twitch.listSubscriptions(accessToken)).filter((subscription) => subscription.callback === callbackUrl)

  const wanted = buildWantedEvents(broadcasterId)
  /** 登録済みの購読が、そのまま使えるか（状態が有効で、種類・バージョン・条件が求めるものと一致する） */
  const isUsableFor = (subscription: RegisteredSubscription, event: (typeof wanted)[number]): boolean =>
    USABLE_STATUSES.includes(subscription.status) &&
    subscription.type === event.type &&
    subscription.version === event.version &&
    isSameCondition(subscription.condition, event.condition)

  // 失効した購読と、内容が合わない購読（配信者のIDを変えた場合など）は消す
  for (const subscription of registered.filter((candidate) => !wanted.some((event) => isUsableFor(candidate, event)))) {
    await twitch.deleteSubscription(accessToken, subscription.id)
  }

  const missing = wanted.filter((event) => !registered.some((subscription) => isUsableFor(subscription, event)))
  for (const { type, version, condition } of missing) {
    const subscription: EventSubSubscription = {
      type,
      version,
      condition,
      transport: { method: 'webhook', callback: callbackUrl, secret },
    }
    await twitch.createSubscription(accessToken, subscription).catch((error: unknown) => {
      throw withEventType(error, type)
    })
  }
  return missing.map(({ type }) => type)
}

/**
 * このWorkerのWebhook宛ての購読を揃える。
 *
 * 配信者のログイン時に呼ぶ。購読の内容は配信者だけで決まる（botのユーザーIDは条件に入らない）ため、
 * botの接続・切断では呼ばない。
 *
 * 注意: Twitchが失敗を返しても、呼び出し元の処理（ログイン）は止めない。
 * 止めると、失敗の記録を読むための管理画面にも入れなくなる。黙って進むのではなく収集の失敗として記録に残す。
 */
export const syncWebhookSubscriptions = async ({ url, env, twitch, now }: Pick<Context, 'url' | 'env' | 'twitch' | 'now'>): Promise<void> => {
  // Twitchは https のURLしかWebhookの宛先として受け付けない。ローカルの開発サーバー（http://localhost）では登録しない
  if (url.protocol !== 'https:') return
  try {
    await ensureWebhookSubscriptions({
      twitch,
      broadcasterId: env.TWITCH_BROADCASTER_ID,
      callbackUrl: `${url.origin}${WEBHOOK_PATH}`,
      secret: env.EVENTSUB_SECRET,
    })
  } catch (error) {
    if (!(error instanceof TwitchApiError)) throw error
    await recordFailure(env.DB, 'webhook-subscription-failed', error.message, now)
  }
}
