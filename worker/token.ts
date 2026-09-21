/**
 * Twitchのトークンの保管と更新
 *
 * このWorkerは2つのTwitchアカウントのトークンを扱う。配信者本人（broadcaster）と、チャットを読み書きする
 * チャットボット（bot）である。役割ごとに別のキーでストア（KV）へ保存し、期限が近ければリフレッシュトークンで取り直す。
 * トークンはWorkerの外（ブラウザ・OBSのURL）へ出さない。
 *
 * 注意: 取り直せない場合に古いトークンを返すことはしない。再ログインが必要であることをエラーで伝える（Fail-Fast）。
 */
import type { KeyValueStore } from './store'
import { TwitchApiError, type TwitchClient } from './twitch'

/** トークンを持つアカウントの役割 */
export type TokenRole = 'broadcaster' | 'bot'

/**
 * 役割ごとのKVのキー。
 *
 * 注意: 配信者のキーは、役割を分ける前から使っている 'twitch-token' のまま据え置く。
 * 変えると、既にログイン済みの環境で配信者のログインが一度切れてしまうため。
 */
const TOKEN_KEYS: Record<TokenRole, string> = {
  broadcaster: 'twitch-token',
  bot: 'twitch-token:bot',
}

/** 未ログインのときの案内。役割によって「やるべきこと」が違うので文言を分ける */
const NOT_LOGGED_IN_MESSAGES: Record<TokenRole, string> = {
  broadcaster: '配信者がまだTwitchでログインしていません。/api/auth/login からログインしてください',
  bot: 'botアカウントがまだ接続されていません。管理画面の「チャットボット」から接続してください',
}
/** 期限切れまでの残りがこれ未満なら取り直す（ミリ秒）。Twitchへ送っている間に切れるのを避ける余裕 */
const REFRESH_MARGIN_MS = 60 * 1000
const MILLISECONDS_PER_SECOND = 1000
/** リフレッシュトークンが無効なときにTwitchが返す状態コード */
const INVALID_REFRESH_TOKEN_STATUSES: readonly number[] = [400, 401]

/** ストアに保存するトークン */
export interface StoredToken {
  accessToken: string
  refreshToken: string
  /** アクセストークンが切れる時刻（ミリ秒） */
  expiresAt: number
  scopes: string[]
  userId: string
  login: string
}

/** 配信者のログインし直しでしか解決しない失敗 */
export class AuthError extends Error {
  override name = 'AuthError'

  constructor(
    readonly code: 'not-logged-in' | 'relogin-required' | 'missing-scope',
    message: string,
  ) {
    super(message)
  }
}

const isStoredToken = (value: unknown): value is StoredToken => {
  if (typeof value !== 'object' || value === null) return false
  const token = value as Record<string, unknown>
  return (
    typeof token.accessToken === 'string' &&
    typeof token.refreshToken === 'string' &&
    typeof token.expiresAt === 'number' &&
    Array.isArray(token.scopes) &&
    typeof token.userId === 'string' &&
    typeof token.login === 'string'
  )
}

export const saveToken = (store: KeyValueStore, role: TokenRole, token: StoredToken): Promise<void> =>
  store.put(TOKEN_KEYS[role], JSON.stringify(token))

/** 保存済みのトークンを消す。保存されていなくてもエラーにしない（切断を何度押しても同じ結果になるように） */
export const deleteToken = (store: KeyValueStore, role: TokenRole): Promise<void> => store.delete(TOKEN_KEYS[role])

/** 保存済みのトークンを読む。未保存なら null、保存内容が壊れていればエラー */
export const loadToken = async (store: KeyValueStore, role: TokenRole): Promise<StoredToken | null> => {
  const key = TOKEN_KEYS[role]
  const text = await store.get(key)
  if (text === null) return null
  const value: unknown = JSON.parse(text)
  if (!isStoredToken(value)) throw new Error(`ストアの ${key} の内容が壊れています。ログインし直してください`)
  return value
}

/**
 * 有効なアクセストークンを返す。期限が近い（または forceRefresh 指定）なら取り直して保存する。
 *
 * @param role どちらのアカウントのトークンか
 * @param now 現在時刻（ミリ秒）
 * @throws AuthError 未ログイン、またはリフレッシュトークンが無効
 */
export const getAccessToken = async (
  store: KeyValueStore,
  role: TokenRole,
  twitch: Pick<TwitchClient, 'refresh'>,
  now: number,
  options: { forceRefresh?: boolean } = {},
): Promise<StoredToken> => {
  const token = await loadToken(store, role)
  if (!token) throw new AuthError('not-logged-in', NOT_LOGGED_IN_MESSAGES[role])
  if (!options.forceRefresh && token.expiresAt - now >= REFRESH_MARGIN_MS) return token

  const grant = await twitch.refresh(token.refreshToken).catch((error: unknown) => {
    if (error instanceof TwitchApiError && INVALID_REFRESH_TOKEN_STATUSES.includes(error.status)) {
      throw new AuthError('relogin-required', `Twitchのトークンを更新できませんでした。ログインし直してください（${error.message}）`)
    }
    throw error
  })
  const refreshed: StoredToken = {
    ...token,
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    expiresAt: now + grant.expiresIn * MILLISECONDS_PER_SECOND,
  }
  await saveToken(store, role, refreshed)
  return refreshed
}
