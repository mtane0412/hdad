/**
 * Twitch APIの呼び出し
 *
 * OAuth（認可コードの交換・トークンの更新・トークンの検証）と、HelixへのEventSub購読の登録を受け持つ。
 * 失敗の応答はすべて TwitchApiError として投げ、呼び出し側が状態コードで扱いを決める。
 * fetch を引数で受け取るのは、テストで実際の通信を差し替えるため。
 */
const AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize'
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate'
const SUBSCRIPTIONS_URL = 'https://api.twitch.tv/helix/eventsub/subscriptions'
/** Twitchの応答として成り立っていない（必要な項目がない）ときに使う状態コード */
const BAD_GATEWAY = 502

/** Twitchが失敗を返した、または応答が想定した形でなかった */
export class TwitchApiError extends Error {
  override name = 'TwitchApiError'

  /** @param status Twitchが返したHTTPの状態コード */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** トークンの発行・更新で受け取る内容 */
export interface TokenGrant {
  accessToken: string
  refreshToken: string
  /** アクセストークンが切れるまでの秒数 */
  expiresIn: number
}

/** アクセストークンの持ち主 */
export interface TokenOwner {
  userId: string
  login: string
  scopes: string[]
}

/** Helixへ登録するEventSubの購読（WebSocket宛て） */
export interface EventSubSubscription {
  type: string
  version: string
  condition: Record<string, string>
  transport: { method: 'websocket'; session_id: string }
}

export interface TwitchClient {
  /** ユーザーをTwitchの認可ページへ送るためのURL */
  authorizeUrl(redirectUri: string, state: string, scopes: readonly string[]): string
  exchangeCode(code: string, redirectUri: string): Promise<TokenGrant>
  refresh(refreshToken: string): Promise<TokenGrant>
  validate(accessToken: string): Promise<TokenOwner>
  createSubscription(accessToken: string, subscription: EventSubSubscription): Promise<void>
}

interface TwitchClientOptions {
  clientId: string
  clientSecret: string
  fetch: typeof fetch
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** 応答の本文をJSONとして読む。失敗の応答なら Twitch のメッセージを添えて投げる */
const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = isRecord(body) && typeof body.message === 'string' ? body.message : response.statusText
    throw new TwitchApiError(response.status, `Twitchが ${response.status} を返しました: ${detail}`)
  }
  if (!isRecord(body)) throw new TwitchApiError(BAD_GATEWAY, 'Twitchの応答がJSONのオブジェクトではありません')
  return body
}

const toTokenGrant = (body: Record<string, unknown>): TokenGrant => {
  const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn } = body
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || typeof expiresIn !== 'number') {
    throw new TwitchApiError(BAD_GATEWAY, 'Twitchのトークン応答に access_token・refresh_token・expires_in が揃っていません')
  }
  return { accessToken, refreshToken, expiresIn }
}

export const createTwitchClient = ({ clientId, clientSecret, fetch: fetchImpl }: TwitchClientOptions): TwitchClient => {
  const requestToken = async (params: Record<string, string>): Promise<TokenGrant> => {
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
    })
    return toTokenGrant(await readJson(response))
  }

  return {
    authorizeUrl: (redirectUri, state, scopes) => {
      const url = new URL(AUTHORIZE_URL)
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: scopes.join(' '),
        state,
      }).toString()
      return url.toString()
    },

    exchangeCode: (code, redirectUri) => requestToken({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),

    refresh: (refreshToken) => requestToken({ grant_type: 'refresh_token', refresh_token: refreshToken }),

    validate: async (accessToken) => {
      const response = await fetchImpl(VALIDATE_URL, { headers: { Authorization: `OAuth ${accessToken}` } })
      const { user_id: userId, login, scopes } = await readJson(response)
      if (typeof userId !== 'string' || typeof login !== 'string' || !Array.isArray(scopes)) {
        throw new TwitchApiError(BAD_GATEWAY, 'Twitchのトークン検証の応答に user_id・login・scopes が揃っていません')
      }
      return { userId, login, scopes: scopes.filter((scope): scope is string => typeof scope === 'string') }
    },

    createSubscription: async (accessToken, subscription) => {
      const response = await fetchImpl(SUBSCRIPTIONS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId, 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription),
      })
      await readJson(response)
    },
  }
}
