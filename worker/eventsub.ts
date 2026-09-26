/**
 * 受け取るイベントの一覧と、そのために配信者・botへ求めるスコープ
 *
 * Twitchからの通知はすべてWebhookでWorkerに届く（eventsub-webhook.ts が購読を揃える）。
 * この一覧はその購読の材料で、オーバーレイはTwitchへ直接つながない。
 */
import { TwitchApiError } from './twitch'

export interface EventType {
  type: string
  version: string
  /** 購読に必要なスコープ（不要なら null） */
  scope: string | null
  condition(broadcasterId: string): Record<string, string>
}

export const byBroadcaster = (broadcasterId: string): Record<string, string> => ({ broadcaster_user_id: broadcasterId })

/**
 * 受け取るイベントの一覧。増やすときはここに足す（スコープが増えた場合は配信者の再ログインが必要）。
 *
 * Webhook宛ての購読はこの一覧をそのまま使い、配信の開始・終了を別に足す（eventsub-webhook.ts）。
 */
export const EVENT_TYPES: readonly EventType[] = [
  { type: 'channel.channel_points_custom_reward_redemption.add', version: '1', scope: 'channel:read:redemptions', condition: byBroadcaster },
  {
    type: 'channel.follow',
    version: '2',
    scope: 'moderator:read:followers',
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId, moderator_user_id: broadcasterId }),
  },
  { type: 'channel.subscribe', version: '1', scope: 'channel:read:subscriptions', condition: byBroadcaster },
  // 継続サブスクの共有メッセージ。channel.subscribe は新規サブスクのときしか届かない
  { type: 'channel.subscription.message', version: '1', scope: 'channel:read:subscriptions', condition: byBroadcaster },
  { type: 'channel.raid', version: '1', scope: null, condition: (broadcasterId) => ({ to_broadcaster_user_id: broadcasterId }) },
  // 「チャットを読む人」（user_id）には配信者自身を指定するため、配信者から user:read:chat と user:bot の
  // 両方を認可してもらう（EXTRA_BROADCASTER_SCOPES）
  {
    type: 'channel.chat.message',
    version: '1',
    scope: 'user:read:chat',
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId, user_id: broadcasterId }),
  },
  // 広告の開始。終了に相当する通知はTwitchにないので、開始の duration_seconds から自前で計る
  // （worker/ad-break-timer.ts が時刻を持ち、擬似イベント channel.ad_break.end として照合へ回す）
  { type: 'channel.ad_break.begin', version: '1', scope: 'channel:read:ads', condition: byBroadcaster },
]

/**
 * イベントの種類には紐づかないが、配信者に認可してもらうスコープ。
 *
 * channel:bot は、チャットの発言をアプリアクセストークンで購読する（Webhook宛て）ために、
 * チャンネルの持ち主である配信者が与えるもの。
 *
 * user:bot は、そのチャットの購読で「チャットを読む人」（user_id）に指定される配信者自身が与えるもの。
 * アプリアクセストークンで channel.chat.message を購読する場合、読む人から user:read:chat に加えて
 * user:bot が要る（user:read:chat のほうは EVENT_TYPES 由来で既に入っている）。
 *
 * moderation:read は、botがこのチャンネルのモデレーターにされているかを
 * 配信者のトークンで確かめる（GET /helix/moderation/moderators）ために要る。
 */
const EXTRA_BROADCASTER_SCOPES: readonly string[] = ['channel:bot', 'user:bot', 'moderation:read']

/** 配信者のログイン時に要求するスコープ（重複なし） */
export const REQUIRED_SCOPES: readonly string[] = [
  ...new Set([...EVENT_TYPES.map((eventType) => eventType.scope).filter((scope) => scope !== null), ...EXTRA_BROADCASTER_SCOPES]),
]

/**
 * botアカウントの接続時に要求するスコープ。
 *
 * user:read:chat と user:bot はチャットの受信に、user:write:chat は送信（POST /helix/chat/messages）に要る。
 * moderator:manage:* はモデレーション操作に要る（banned_users はBAN・タイムアウト、chat_messages は発言の削除、
 * announcements はアナウンス、shoutouts はシャウトアウト）。いずれも、botがこのチャンネルのモデレーターにされていることが前提。
 *
 * 注意: スコープが足りないと接続し直しになるため、後の段階で使うものも最初からまとめて認可してもらう。
 */
export const BOT_SCOPES: readonly string[] = [
  'user:bot',
  'user:read:chat',
  'user:write:chat',
  'moderator:manage:banned_users',
  'moderator:manage:chat_messages',
  'moderator:manage:announcements',
  'moderator:manage:shoutouts',
]

/** Twitchのエラーに、どのイベントの購読で起きたかを書き足す */
export const withEventType = (error: unknown, type: string): unknown =>
  error instanceof TwitchApiError ? new TwitchApiError(error.status, `${type} の購読に失敗しました: ${error.message}`) : error
