/**
 * Twitchのトークンの保管と更新
 *
 * 配信者1人分のトークンをストア（KV）に保存し、期限が近ければリフレッシュトークンで取り直す。
 * トークンはWorkerの外（ブラウザ・OBSのURL）へ出さない。
 *
 * 注意: 取り直せない場合に古いトークンを返すことはしない。再ログインが必要であることをエラーで伝える（Fail-Fast）。
 */
import type { KeyValueStore } from './store'
import { TwitchApiError, type TwitchClient } from './twitch'

const TOKEN_KEY = 'twitch-token'
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

export const saveToken = (store: KeyValueStore, token: StoredToken): Promise<void> => store.put(TOKEN_KEY, JSON.stringify(token))

/** 保存済みのトークンを読む。未保存なら null、保存内容が壊れていればエラー */
export const loadToken = async (store: KeyValueStore): Promise<StoredToken | null> => {
  const text = await store.get(TOKEN_KEY)
  if (text === null) return null
  const value: unknown = JSON.parse(text)
  if (!isStoredToken(value)) throw new Error(`ストアの ${TOKEN_KEY} の内容が壊れています。ログインし直してください`)
  return value
}

/**
 * 有効なアクセストークンを返す。期限が近い（または forceRefresh 指定）なら取り直して保存する。
 *
 * @param now 現在時刻（ミリ秒）
 * @throws AuthError 未ログイン、またはリフレッシュトークンが無効
 */
export const getAccessToken = async (
  store: KeyValueStore,
  twitch: Pick<TwitchClient, 'refresh'>,
  now: number,
  options: { forceRefresh?: boolean } = {},
): Promise<StoredToken> => {
  const token = await loadToken(store)
  if (!token) throw new AuthError('not-logged-in', '配信者がまだTwitchでログインしていません。/api/auth/login からログインしてください')
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
  await saveToken(store, refreshed)
  return refreshed
}
