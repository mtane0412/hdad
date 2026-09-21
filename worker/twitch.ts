/**
 * Twitch APIの呼び出し
 *
 * OAuth（認可コードの交換・トークンの更新・トークンの検証）と、HelixへのEventSub購読の登録、チャンネルポイント報酬の一覧の取得、
 * 配信の記録のための取得（いまの配信・フォロワー数）を受け持つ。
 * 失敗の応答はすべて TwitchApiError として投げ、呼び出し側が状態コードで扱いを決める。
 * fetch を引数で受け取るのは、テストで実際の通信を差し替えるため。
 */
const AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize'
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate'
const SUBSCRIPTIONS_URL = 'https://api.twitch.tv/helix/eventsub/subscriptions'
const CUSTOM_REWARDS_URL = 'https://api.twitch.tv/helix/channel_points/custom_rewards'
const STREAMS_URL = 'https://api.twitch.tv/helix/streams'
const FOLLOWERS_URL = 'https://api.twitch.tv/helix/channels/followers'
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

/** チャンネルポイント報酬のうち、管理画面で選ぶのに必要な項目 */
export interface CustomReward {
  id: string
  title: string
  /** 交換に必要なポイント */
  cost: number
}

/** いま行われている配信 */
export interface LiveStream {
  /** Twitchの配信ID */
  id: string
  /** 配信を始めた日時（UTCのISO 8601。ミリ秒付きに揃えてある） */
  startedAt: string
  title: string
  /** カテゴリ未設定なら空文字 */
  categoryName: string
  viewerCount: number
}

export interface TwitchClient {
  /** ユーザーをTwitchの認可ページへ送るためのURL */
  authorizeUrl(redirectUri: string, state: string, scopes: readonly string[]): string
  exchangeCode(code: string, redirectUri: string): Promise<TokenGrant>
  refresh(refreshToken: string): Promise<TokenGrant>
  validate(accessToken: string): Promise<TokenOwner>
  createSubscription(accessToken: string, subscription: EventSubSubscription): Promise<void>
  /** 配信者のチャンネルポイント報酬の一覧（channel:read:redemptions が必要。Twitchの上限は50件で、ページ分けはない） */
  listCustomRewards(accessToken: string, broadcasterId: string): Promise<CustomReward[]>
  /** 配信者がいま行っている配信。配信していなければ null */
  getLiveStream(accessToken: string, broadcasterId: string): Promise<LiveStream | null>
  /** 配信者のフォロワー数（moderator:read:followers が必要） */
  getFollowerTotal(accessToken: string, broadcasterId: string): Promise<number>
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

const toCustomReward = (value: unknown): CustomReward => {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.cost !== 'number') {
    throw new TwitchApiError(BAD_GATEWAY, 'Twitchの報酬の応答に id・title・cost が揃っていません')
  }
  return { id: value.id, title: value.title, cost: value.cost }
}

const toLiveStream = (value: unknown): LiveStream => {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.started_at !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.game_name !== 'string' ||
    typeof value.viewer_count !== 'number'
  ) {
    throw new TwitchApiError(BAD_GATEWAY, 'Twitchの配信の応答に id・started_at・title・game_name・viewer_count が揃っていません')
  }
  const startedAt = Date.parse(value.started_at)
  if (Number.isNaN(startedAt)) throw new TwitchApiError(BAD_GATEWAY, `Twitchの配信の応答の started_at（${value.started_at}）を日時として読めません`)
  return {
    id: value.id,
    startedAt: new Date(startedAt).toISOString(),
    title: value.title,
    categoryName: value.game_name,
    viewerCount: value.viewer_count,
  }
}

export const createTwitchClient = ({ clientId, clientSecret, fetch: fetchImpl }: TwitchClientOptions): TwitchClient => {
  const requestToken = async (params: Record<string, string>): Promise<TokenGrant> => {
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
    })
    return toTokenGrant(await readJson(response))
  }

  const getHelix = async (url: URL, accessToken: string): Promise<Record<string, unknown>> =>
    readJson(await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId } }))

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

    listCustomRewards: async (accessToken, broadcasterId) => {
      const url = new URL(CUSTOM_REWARDS_URL)
      url.searchParams.set('broadcaster_id', broadcasterId)
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId } })
      const { data } = await readJson(response)
      if (!Array.isArray(data)) throw new TwitchApiError(BAD_GATEWAY, 'Twitchの報酬の応答に data の配列がありません')
      return data.map(toCustomReward)
    },

    getLiveStream: async (accessToken, broadcasterId) => {
      const url = new URL(STREAMS_URL)
      url.searchParams.set('user_id', broadcasterId)
      const { data } = await getHelix(url, accessToken)
      if (!Array.isArray(data)) throw new TwitchApiError(BAD_GATEWAY, 'Twitchの配信の応答に data の配列がありません')
      return data.length === 0 ? null : toLiveStream(data[0])
    },

    getFollowerTotal: async (accessToken, broadcasterId) => {
      const url = new URL(FOLLOWERS_URL)
      url.searchParams.set('broadcaster_id', broadcasterId)
      // 数だけが要るので、フォロワーの一覧は最小の1件にする
      url.searchParams.set('first', '1')
      const { total } = await getHelix(url, accessToken)
      if (typeof total !== 'number') throw new TwitchApiError(BAD_GATEWAY, 'Twitchのフォロワーの応答に total がありません')
      return total
    },
  }
}
