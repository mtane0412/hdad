/**
 * Twitchのトークンの保管と更新
 *
 * このWorkerは2つのTwitchアカウントのトークンを扱う。配信者本人（broadcaster）と、チャットを読み書きする
 * チャットボット（bot）である。役割ごとに保管庫（Durable Object。worker/token-vault.ts）へ保存し、
 * 期限が近ければリフレッシュトークンで取り直す。トークンはWorkerの外（ブラウザ・OBSのURL）へ出さない。
 *
 * 注意: 取り直せない場合に古いトークンを返すことはしない。再ログインが必要であることをエラーで伝える（Fail-Fast）。
 * 注意: 取り直している間に保存済みのトークンが消された・差し替えられた（切断・付け替え）場合は、取り直した結果を
 * 書き戻さず、使いもしない。書き戻すと、切断や付け替えが取り消されてしまうため（issue #201）。
 * 確かめることと書き戻すことは、保管庫への1回の要求（置き換え）にまとめ、間に切断・付け替えが割り込めないようにしている（issue #220）。
 * 注意: 保管庫から外したトークン（切断・付け替え・書き戻さずに捨てた更新の結果）は、Twitch上でも失効させる（revokeReleasedToken。issue #221）。
 */
import { REPLACE_PATH, TOKEN_PATH, TOKEN_VAULT_NAME, type ReplaceExpectation, type ReplaceResult, type TokenVaultNamespace } from './token-vault'
import { HttpError, STATUS } from './http'
import { TwitchApiError, type TwitchClient } from './twitch'

/** トークンを持つアカウントの役割 */
export type TokenRole = 'broadcaster' | 'bot'

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
    readonly code: 'not-logged-in' | 'relogin-required' | 'missing-scope' | 'token-changed',
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

const REPLACE_RESULTS: readonly ReplaceResult[] = ['replaced', 'missing', 'changed']

/** 保管庫へ要求を送る。保管庫が失敗を返したら、どの操作が失敗したかを添えてエラーにする（未保存の404だけは呼び出し側が読む） */
const requestVault = async (vault: TokenVaultNamespace, role: TokenRole, path: string, init: RequestInit): Promise<Response> => {
  const url = `https://token-vault${path}?role=${role}`
  const response = await vault.get(vault.idFromName(TOKEN_VAULT_NAME)).fetch(new Request(url, init))
  if (!response.ok && response.status !== STATUS.notFound) {
    throw new Error(`トークンの保管庫への要求（${init.method} ${path}）が失敗しました（${response.status}）`)
  }
  return response
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

/** 保存・削除の応答から、それまで保存していたトークンを取り出す。無ければ null、内容が壊れていればエラー */
const readPrevious = async (response: Response, role: TokenRole): Promise<StoredToken | null> => {
  const body: unknown = await response.json()
  const previous = typeof body === 'object' && body !== null && 'previous' in body ? body.previous : undefined
  if (previous === null) return null
  if (!isStoredToken(previous)) throw new Error(`保管庫の ${role} のトークンの内容が壊れていたため、外したトークンを失効させられません`)
  return previous
}

/**
 * トークンを保存する。上書きしたトークン（初めてなら null）を返す。
 *
 * 前の値は、保管庫が上書きと同じ1回の要求の中で読んで返す。別に読み直すと、その間の更新・付け替えを取りこぼすため。
 */
export const saveToken = async (vault: TokenVaultNamespace, role: TokenRole, token: StoredToken): Promise<StoredToken | null> =>
  readPrevious(await requestVault(vault, role, TOKEN_PATH, jsonInit('PUT', token)), role)

/**
 * 保存済みのトークンを消し、消したトークン（無ければ null）を返す。
 * 保存されていなくてもエラーにしない（切断を何度押しても同じ結果になるように）。
 */
export const deleteToken = async (vault: TokenVaultNamespace, role: TokenRole): Promise<StoredToken | null> =>
  readPrevious(await requestVault(vault, role, TOKEN_PATH, { method: 'DELETE' }), role)

/** リフレッシュトークンで取り直す。無効（400・401）なら再ログインを求めるエラーにする */
const refreshOrRelogin = (twitch: Pick<TwitchClient, 'refresh'>, refreshToken: string) =>
  twitch.refresh(refreshToken).catch((error: unknown) => {
    if (error instanceof TwitchApiError && INVALID_REFRESH_TOKEN_STATUSES.includes(error.status)) {
      throw new AuthError('relogin-required', `Twitchのトークンを更新できませんでした。ログインし直してください（${error.message}）`)
    }
    throw error
  })

/**
 * 保管庫から外した（切断・付け替えで消した・上書きした）トークンを、Twitchで失効させる（issue #221）。
 *
 * 保管庫から外しただけでは、Twitch上ではトークンが有効なまま残る。外したアカウントの権限を確実に止めるために失効させる。
 * アクセストークンが期限切れのときは、Twitchが失効の要求を「すでに無効」として受け流し、リフレッシュトークンが生き残るので、
 * 先に取り直してから新しいアクセストークンを失効させる。リフレッシュトークンもすでに無効なら、失効させるものは無い。
 *
 * 注意: 呼ぶのは保管庫から外したあと。Twitchの障害で切断・付け替えそのものができなくなるのを避けるため、
 * 失効に失敗しても保管庫には戻さず、手で解除するよう案内するエラーにする。
 *
 * @param now 現在時刻（ミリ秒）
 * @throws HttpError 失効させられなかった（502・revoke-failed）
 */
export const revokeReleasedToken = async (twitch: Pick<TwitchClient, 'refresh' | 'revoke'>, token: StoredToken, now: number): Promise<void> => {
  try {
    if (token.expiresAt > now) {
      await twitch.revoke(token.accessToken)
      return
    }
    const grant = await refreshOrRelogin(twitch, token.refreshToken).catch((error: unknown) => {
      // リフレッシュトークンもすでに無効なら、失効させるものは無い
      if (error instanceof AuthError) return null
      throw error
    })
    if (grant) await twitch.revoke(grant.accessToken)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new HttpError(
      STATUS.badGateway,
      'revoke-failed',
      `HDADからは ${token.login} のトークンを外しましたが、Twitch上で失効させられませんでした。Twitchの設定の「接続」から、このアプリの接続を解除してください（${detail}）`,
    )
  }
}

/** 保存済みのトークンを読む。未保存なら null、保存内容が壊れていればエラー */
export const loadToken = async (vault: TokenVaultNamespace, role: TokenRole): Promise<StoredToken | null> => {
  const response = await requestVault(vault, role, TOKEN_PATH, { method: 'GET' })
  if (response.status === STATUS.notFound) return null
  const value: unknown = JSON.parse(await response.text())
  if (!isStoredToken(value)) throw new Error(`保管庫の ${role} のトークンの内容が壊れています。ログインし直してください`)
  return value
}

/** 保存済みのトークンが expected のものであるときだけ、next に置き換える */
const replaceToken = async (vault: TokenVaultNamespace, role: TokenRole, expected: ReplaceExpectation, next: StoredToken): Promise<ReplaceResult> => {
  const response = await requestVault(vault, role, REPLACE_PATH, jsonInit('POST', { expected, next }))
  const body: unknown = await response.json()
  const result = typeof body === 'object' && body !== null && 'result' in body ? body.result : undefined
  const known = REPLACE_RESULTS.find((candidate) => candidate === result)
  if (known === undefined) throw new Error(`トークンの保管庫が想定外の結果を返しました（${JSON.stringify(body)}）`)
  return known
}

/**
 * 有効なアクセストークンを返す。期限が近い（または forceRefresh 指定）なら取り直して保存する。
 *
 * @param role どちらのアカウントのトークンか
 * @param now 現在時刻（ミリ秒）
 * @throws AuthError 未ログイン、またはリフレッシュトークンが無効
 * @throws HttpError 取り直している間に切断・付け替えされ、捨てたトークンを失効させられなかった（revoke-failed）
 */
export const getAccessToken = async (
  vault: TokenVaultNamespace,
  role: TokenRole,
  twitch: Pick<TwitchClient, 'refresh' | 'revoke'>,
  now: number,
  options: { forceRefresh?: boolean } = {},
): Promise<StoredToken> => {
  const token = await loadToken(vault, role)
  if (!token) throw new AuthError('not-logged-in', NOT_LOGGED_IN_MESSAGES[role])
  if (!options.forceRefresh && token.expiresAt - now >= REFRESH_MARGIN_MS) return token

  const grant = await refreshOrRelogin(twitch, token.refreshToken)
  const refreshed: StoredToken = {
    ...token,
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    expiresAt: now + grant.expiresIn * MILLISECONDS_PER_SECOND,
  }
  // Twitchへの更新を待つ間に切断・付け替えされていたら、書き戻すとそれを取り消してしまう。
  // 確かめることと書き戻すことを保管庫への1回の要求にまとめ、その間に割り込まれないようにする
  const result = await replaceToken(vault, role, { userId: token.userId, refreshToken: token.refreshToken }, refreshed)
  // 書き戻さずに捨てるトークンも、Twitch上では有効なまま残るので失効させる（issue #221）
  if (result !== 'replaced') await revokeReleasedToken(twitch, refreshed, now)
  if (result === 'missing') throw new AuthError('not-logged-in', NOT_LOGGED_IN_MESSAGES[role])
  if (result === 'changed') {
    throw new AuthError('token-changed', 'トークンを更新している間に、アカウントが接続し直されました。もう一度試してください')
  }
  return refreshed
}
