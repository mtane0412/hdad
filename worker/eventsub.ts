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

interface EventType {
  type: string
  version: string
  /** 購読に必要なスコープ（不要なら null） */
  scope: string | null
  condition(broadcasterId: string): Record<string, string>
}

const byBroadcaster = (broadcasterId: string): Record<string, string> => ({ broadcaster_user_id: broadcasterId })

/** 受け取るイベントの一覧。増やすときはここに足す（スコープが増えた場合は配信者の再ログインが必要） */
const EVENT_TYPES: readonly EventType[] = [
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
]

/** ログイン時に要求するスコープ（重複なし） */
export const REQUIRED_SCOPES: readonly string[] = [
  ...new Set(EVENT_TYPES.map((eventType) => eventType.scope).filter((scope) => scope !== null)),
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
const withEventType = (error: unknown, type: string): unknown =>
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
  let token = await getAccessToken(store, twitch, now)

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
      token = await getAccessToken(store, twitch, now, { forceRefresh: true })
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
