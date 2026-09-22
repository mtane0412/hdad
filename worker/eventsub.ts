/**
 * EventSub購読の代行
 *
 * オーバーレイ（ブラウザ）はEventSubのWebSocketを自分で開くが、購読の登録にはユーザートークンが要る。
 * トークンをブラウザへ出さないため、オーバーレイからセッションIDだけを受け取り、Workerが登録を代行する。
 * 登録後のイベントはTwitchからオーバーレイへ直接届く。
 *
 * 配信者自身のトークンで自分のチャンネルを購読するため、購読のコスト（WebSocket 1本あたり上限10）は消費しない。
 */
import type { KeyValueStore } from './store'
import { AuthError, getAccessToken } from './token'
import { TwitchApiError, type EventSubSubscription, type TwitchClient } from './twitch'

const UNAUTHORIZED = 401

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
 * ここに並ぶのはオーバーレイ（EventSubのWebSocket）が受け取るイベントで、購読は配信者のトークンで登録する。
 * Webhook宛ての購読はこの一覧から件数を数えるものだけを拾い、配信の開始・終了とチャットを別に足す（eventsub-webhook.ts）。
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
  // 「チャットを読む人」（user_id）には配信者自身を指定する。Webhook宛ての購読（eventsub-webhook.ts）も
  // この定義をそのまま使うため、配信者から user:read:chat と user:bot の両方を認可してもらう（EXTRA_BROADCASTER_SCOPES）
  {
    type: 'channel.chat.message',
    version: '1',
    scope: 'user:read:chat',
    condition: (broadcasterId) => ({ broadcaster_user_id: broadcasterId, user_id: broadcasterId }),
  },
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
 * announcements はアナウンス）。いずれも、botがこのチャンネルのモデレーターにされていることが前提。
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
]

/** EventSubのWebSocketセッション宛ての購読を、受け取るイベントの数だけ組み立てる */
export const buildSubscriptions = (broadcasterId: string, sessionId: string): EventSubSubscription[] =>
  EVENT_TYPES.map(({ type, version, condition }) => ({
    type,
    version,
    condition: condition(broadcasterId),
    transport: { method: 'websocket', session_id: sessionId },
  }))

/** Twitchのエラーに、どのイベントの購読で起きたかを書き足す */
export const withEventType = (error: unknown, type: string): unknown =>
  error instanceof TwitchApiError ? new TwitchApiError(error.status, `${type} の購読に失敗しました: ${error.message}`) : error

interface SubscribeAllOptions {
  store: KeyValueStore
  twitch: Pick<TwitchClient, 'refresh' | 'createSubscription'>
  broadcasterId: string
  sessionId: string
  /** 現在時刻（ミリ秒） */
  now: number
}

/**
 * 保管しているトークンで、すべてのイベントの購読を登録する。
 *
 * @returns 登録したイベントの種類
 * @throws AuthError 未ログイン・再ログインが必要・スコープ不足
 * @throws TwitchApiError Twitchが購読を拒否した（どのイベントかをメッセージに含む）
 */
export const subscribeAll = async ({ store, twitch, broadcasterId, sessionId, now }: SubscribeAllOptions): Promise<string[]> => {
  let token = await getAccessToken(store, 'broadcaster', twitch, now)

  const missingScopes = REQUIRED_SCOPES.filter((scope) => !token.scopes.includes(scope))
  if (missingScopes.length > 0) {
    throw new AuthError('missing-scope', `Twitchのトークンにスコープが足りません。ログインし直してください（不足: ${missingScopes.join(', ')}）`)
  }

  let refreshed = false
  const create = async (subscription: EventSubSubscription): Promise<void> => {
    try {
      await twitch.createSubscription(token.accessToken, subscription)
    } catch (error) {
      const tokenRejected = error instanceof TwitchApiError && error.status === UNAUTHORIZED
      if (!tokenRejected || refreshed) throw error
      // 期限内でもTwitch側で無効になっていることがある（パスワード変更など）。1回だけ取り直してやり直す
      refreshed = true
      token = await getAccessToken(store, 'broadcaster', twitch, now, { forceRefresh: true })
      await twitch.createSubscription(token.accessToken, subscription)
    }
  }

  const subscriptions = buildSubscriptions(broadcasterId, sessionId)
  for (const subscription of subscriptions) {
    await create(subscription).catch((error: unknown) => {
      throw withEventType(error, subscription.type)
    })
  }
  return subscriptions.map((subscription) => subscription.type)
}
