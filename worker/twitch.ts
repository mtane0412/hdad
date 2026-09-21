/**
 * Twitch APIの呼び出し
 *
 * OAuth（認可コードの交換・トークンの更新・トークンの検証・アプリアクセストークンの発行）と、HelixへのEventSub購読の登録・一覧・削除、チャンネルポイント報酬の一覧の取得、
 * 配信の記録のための取得（いまの配信・フォロワー数）、チャットへのメッセージ送信を受け持つ。
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
const GLOBAL_BADGES_URL = 'https://api.twitch.tv/helix/chat/badges/global'
const CHANNEL_BADGES_URL = 'https://api.twitch.tv/helix/chat/badges'
const CHEERMOTES_URL = 'https://api.twitch.tv/helix/bits/cheermotes'
const USERS_URL = 'https://api.twitch.tv/helix/users'
const CHAT_MESSAGES_URL = 'https://api.twitch.tv/helix/chat/messages'
const DEVICE_URL = 'https://id.twitch.tv/oauth2/device'
/** デバイスコードフローの grant_type（RFC 8628 の決まった文字列） */
const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
/**
 * トークン交換で「まだ認可されていない」ことを表す、Twitchの失敗メッセージ（RFC 8628 のエラーコード）。
 *
 * 注意: これ以外の失敗（期限切れ・拒否・設定の誤り）を待っている状態として飲み込まない。
 * 飲み込むと、いつまでも終わらないポーリングになる。
 */
const PENDING_MESSAGES: readonly string[] = ['authorization_pending', 'slow_down']
/** バッジ・Cheermote の画像は複数の大きさで届く。オーバーレイでは2倍のものを使う */
const IMAGE_SCALE = '2'
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

/**
 * Helixへ登録するEventSubの購読。
 * WebSocket宛て（オーバーレイ）はユーザートークンで、Webhook宛て（配信の記録）はアプリアクセストークンで登録する。
 */
export interface EventSubSubscription {
  type: string
  version: string
  condition: Record<string, string>
  transport: { method: 'websocket'; session_id: string } | { method: 'webhook'; callback: string; secret: string }
}

/** 登録済みのEventSubの購読のうち、Webhook宛ての購読の整理に必要な項目 */
export interface RegisteredSubscription {
  id: string
  /** enabled・webhook_callback_verification_pending のほか、失効の理由（authorization_revoked など） */
  status: string
  type: string
  version: string
  /** 購読の条件（どの配信者のイベントか）。文字列でない値は含めない */
  condition: Record<string, string>
  /** Webhook宛てならコールバックのURL。それ以外は null */
  callback: string | null
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

/** デバイスコードフローの開始で受け取る内容 */
export interface DeviceAuthorization {
  /** トークンと交換するためのコード。利用者には見せず、交換のときにそのまま送り返す */
  deviceCode: string
  /** 利用者が認可の画面で入力するコード（8文字） */
  userCode: string
  /** 利用者を案内する先のURL */
  verificationUri: string
  /** コードが使えなくなるまでの秒数 */
  expiresIn: number
  /** 次に交換を試すまで空ける秒数 */
  intervalSeconds: number
}

/** デバイスコードの交換の結果。まだ利用者が認可していない場合は失敗ではなく pending */
export type DeviceCodeExchange = { status: 'pending' } | { status: 'granted'; grant: TokenGrant }

/** チャットへ送るメッセージ */
export interface ChatMessageToSend {
  /** 送り先のチャンネルの持ち主のユーザーID */
  broadcasterId: string
  /** 送信者のユーザーID。アクセストークンの持ち主と一致している必要がある */
  senderId: string
  /** 本文（Twitchの上限は500文字） */
  message: string
}

export interface TwitchClient {
  /** ユーザーをTwitchの認可ページへ送るためのURL */
  authorizeUrl(redirectUri: string, state: string, scopes: readonly string[]): string
  exchangeCode(code: string, redirectUri: string): Promise<TokenGrant>
  refresh(refreshToken: string): Promise<TokenGrant>
  validate(accessToken: string): Promise<TokenOwner>
  /** アプリアクセストークン（ユーザーに紐づかないトークン）を発行する。Webhook宛ての購読の登録・一覧・削除に要る */
  getAppAccessToken(): Promise<string>
  /** このアプリが登録しているEventSubの購読をすべて返す（アプリアクセストークンならWebhook宛てが返る） */
  listSubscriptions(accessToken: string): Promise<RegisteredSubscription[]>
  deleteSubscription(accessToken: string, id: string): Promise<void>
  createSubscription(accessToken: string, subscription: EventSubSubscription): Promise<void>
  /** 配信者のチャンネルポイント報酬の一覧（channel:read:redemptions が必要。Twitchの上限は50件で、ページ分けはない） */
  listCustomRewards(accessToken: string, broadcasterId: string): Promise<CustomReward[]>
  /** 配信者がいま行っている配信。配信していなければ null */
  getLiveStream(accessToken: string, broadcasterId: string): Promise<LiveStream | null>
  /** 配信者のフォロワー数（moderator:read:followers が必要） */
  getFollowerTotal(accessToken: string, broadcasterId: string): Promise<number>
  /**
   * チャットのバッジ画像の一覧。スコープは不要で、アプリアクセストークンでも読める。
   *
   * @param broadcasterId 指定するとそのチャンネル固有のバッジ（サブスク階層など）、undefined なら全体のバッジ
   */
  getChatBadges(accessToken: string, broadcasterId: string | undefined): Promise<ChatBadgeSet[]>
  /** Cheermote（ビッツの絵）の一覧。全体のものと、指定したチャンネル固有のものが返る。スコープは不要 */
  getCheermotes(accessToken: string, broadcasterId: string): Promise<Cheermote[]>
  /** ユーザーIDからログイン名（twitch.tv/ の後ろの部分）を引く。スコープは不要 */
  getUserLogin(accessToken: string, userId: string): Promise<string>
  /**
   * チャットへメッセージを送る。送信者（senderId）のユーザートークンと user:write:chat が必要。
   *
   * @throws TwitchApiError Twitchが拒否した、またはTwitchが受け取ったうえで送信しなかった（AutoModなど）
   */
  sendChatMessage(accessToken: string, message: ChatMessageToSend): Promise<void>
  /**
   * デバイスコードフローを始める。利用者は別の端末で verificationUri を開き、userCode を入力して認可する。
   *
   * リダイレクトURLを使わないため、認可を行う端末と、トークンを受け取るこのWorkerを分けられる。
   */
  startDeviceAuthorization(scopes: readonly string[]): Promise<DeviceAuthorization>
  /**
   * デバイスコードをトークンに交換する。まだ利用者が認可していなければ pending を返す（失敗にしない）。
   *
   * @throws TwitchApiError コードの期限切れ・利用者が拒否・そのほかの失敗
   */
  exchangeDeviceCode(deviceCode: string, scopes: readonly string[]): Promise<DeviceCodeExchange>
}

/** バッジの版（同じ種類でも、サブスクの階層やビッツの段階で絵が変わる） */
export interface ChatBadgeVersion {
  /** 版のID。IRCの badges タグの「種類/版」の版にあたる */
  readonly id: string
  readonly imageUrl: string
  /** 英語の名前（例: Subscriber）。読み上げや代替テキストに使う */
  readonly title: string
}

/** バッジの種類（例: broadcaster・subscriber）と、その版の一覧 */
export interface ChatBadgeSet {
  /** 種類のID。IRCの badges タグの「種類/版」の種類にあたる */
  readonly setId: string
  readonly versions: readonly ChatBadgeVersion[]
}

/** Cheermote の段階（ビッツ数が多いほど上の段階になる） */
export interface CheermoteTier {
  readonly minBits: number
  /** 段階の色（#rrggbb）。ビッツ数の文字色に使う */
  readonly color: string
  readonly imageUrl: string
}

/** Cheermote 1種類（本文では「接頭辞＋ビッツ数」の形で書かれる。例: Cheer100） */
export interface Cheermote {
  readonly prefix: string
  readonly tiers: readonly CheermoteTier[]
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

/** チャットを送れなかった理由（Twitchの drop_reason）を、管理画面に出せる文にする */
const readDropReason = (dropReason: unknown): string => {
  if (!isRecord(dropReason)) return '理由は示されませんでした'
  const { code, message } = dropReason
  return typeof message === 'string' && message !== '' ? message : typeof code === 'string' ? code : '理由は示されませんでした'
}

const toDeviceAuthorization = (body: Record<string, unknown>): DeviceAuthorization => {
  const { device_code: deviceCode, user_code: userCode, verification_uri: verificationUri, expires_in: expiresIn, interval } = body
  if (
    typeof deviceCode !== 'string' ||
    typeof userCode !== 'string' ||
    typeof verificationUri !== 'string' ||
    typeof expiresIn !== 'number' ||
    typeof interval !== 'number'
  ) {
    throw new TwitchApiError(BAD_GATEWAY, 'Twitchのデバイスコードの応答に device_code・user_code・verification_uri・expires_in・interval が揃っていません')
  }
  return { deviceCode, userCode, verificationUri, expiresIn, intervalSeconds: interval }
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

const toChatBadgeVersion = (value: unknown): ChatBadgeVersion => {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value[`image_url_${IMAGE_SCALE}x`] !== 'string' || typeof value.title !== 'string') {
    throw new TwitchApiError(BAD_GATEWAY, `Twitchのバッジの応答に id・image_url_${IMAGE_SCALE}x・title が揃っていません`)
  }
  return { id: value.id, imageUrl: String(value[`image_url_${IMAGE_SCALE}x`]), title: value.title }
}

const toChatBadgeSet = (value: unknown): ChatBadgeSet => {
  if (!isRecord(value) || typeof value.set_id !== 'string' || !Array.isArray(value.versions)) {
    throw new TwitchApiError(BAD_GATEWAY, 'Twitchのバッジの応答に set_id・versions が揃っていません')
  }
  return { setId: value.set_id, versions: value.versions.map(toChatBadgeVersion) }
}

const toCheermoteTier = (value: unknown): CheermoteTier => {
  if (!isRecord(value) || typeof value.min_bits !== 'number' || typeof value.color !== 'string') {
    throw new TwitchApiError(BAD_GATEWAY, 'TwitchのCheermoteの応答に min_bits・color が揃っていません')
  }
  // 画像は images.<テーマ>.<動きの有無>.<倍率> の入れ子で届く。暗い背景に合う、動きのある2倍の絵を使う
  const { dark } = isRecord(value.images) ? value.images : {}
  const animated = isRecord(dark) ? dark.animated : undefined
  const imageUrl = isRecord(animated) ? animated[IMAGE_SCALE] : undefined
  if (typeof imageUrl !== 'string') {
    throw new TwitchApiError(BAD_GATEWAY, `TwitchのCheermoteの応答に images.dark.animated.${IMAGE_SCALE} がありません`)
  }
  return { minBits: value.min_bits, color: value.color, imageUrl }
}

const toCheermote = (value: unknown): Cheermote => {
  if (!isRecord(value) || typeof value.prefix !== 'string' || !Array.isArray(value.tiers)) {
    throw new TwitchApiError(BAD_GATEWAY, 'TwitchのCheermoteの応答に prefix・tiers が揃っていません')
  }
  return { prefix: value.prefix, tiers: value.tiers.map(toCheermoteTier) }
}

const toRegisteredSubscription = (value: unknown): RegisteredSubscription => {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.status !== 'string' ||
    typeof value.type !== 'string' ||
    typeof value.version !== 'string' ||
    !isRecord(value.condition) ||
    !isRecord(value.transport)
  ) {
    throw new TwitchApiError(BAD_GATEWAY, 'Twitchの購読の応答に id・status・type・version・condition・transport が揃っていません')
  }
  const { callback } = value.transport
  const condition = Object.fromEntries(Object.entries(value.condition).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  return {
    id: value.id,
    status: value.status,
    type: value.type,
    version: value.version,
    condition,
    callback: typeof callback === 'string' ? callback : null,
  }
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

    getAppAccessToken: async () => {
      const response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
      })
      // アプリアクセストークンにはリフレッシュトークンが無い。切れたら発行し直す
      const { access_token: accessToken } = await readJson(response)
      if (typeof accessToken !== 'string') throw new TwitchApiError(BAD_GATEWAY, 'Twitchのトークン応答に access_token がありません')
      return accessToken
    },

    listSubscriptions: async (accessToken) => {
      const subscriptions: RegisteredSubscription[] = []
      let cursor: string | null = null
      do {
        const url = new URL(SUBSCRIPTIONS_URL)
        if (cursor) url.searchParams.set('after', cursor)
        const { data, pagination } = await getHelix(url, accessToken)
        if (!Array.isArray(data)) throw new TwitchApiError(BAD_GATEWAY, 'Twitchの購読の応答に data の配列がありません')
        subscriptions.push(...data.map(toRegisteredSubscription))
        cursor = isRecord(pagination) && typeof pagination.cursor === 'string' && pagination.cursor !== '' ? pagination.cursor : null
      } while (cursor)
      return subscriptions
    },

    deleteSubscription: async (accessToken, id) => {
      const url = new URL(SUBSCRIPTIONS_URL)
      url.searchParams.set('id', id)
      const response = await fetchImpl(url, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId } })
      // 成功の応答（204）には本文がない
      if (!response.ok) await readJson(response)
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

    getChatBadges: async (accessToken, broadcasterId) => {
      const url = new URL(broadcasterId === undefined ? GLOBAL_BADGES_URL : CHANNEL_BADGES_URL)
      if (broadcasterId !== undefined) url.searchParams.set('broadcaster_id', broadcasterId)
      const { data } = await getHelix(url, accessToken)
      if (!Array.isArray(data)) throw new TwitchApiError(BAD_GATEWAY, 'Twitchのバッジの応答に data の配列がありません')
      return data.map(toChatBadgeSet)
    },

    getCheermotes: async (accessToken, broadcasterId) => {
      const url = new URL(CHEERMOTES_URL)
      url.searchParams.set('broadcaster_id', broadcasterId)
      const { data } = await getHelix(url, accessToken)
      if (!Array.isArray(data)) throw new TwitchApiError(BAD_GATEWAY, 'TwitchのCheermoteの応答に data の配列がありません')
      return data.map(toCheermote)
    },

    getUserLogin: async (accessToken, userId) => {
      const url = new URL(USERS_URL)
      url.searchParams.set('id', userId)
      const { data } = await getHelix(url, accessToken)
      const user: unknown = Array.isArray(data) ? data[0] : undefined
      if (!isRecord(user) || typeof user.login !== 'string') {
        throw new TwitchApiError(BAD_GATEWAY, `TwitchにユーザーID ${userId} のログイン名がありません`)
      }
      return user.login
    },

    sendChatMessage: async (accessToken, { broadcasterId, senderId, message }) => {
      const response = await fetchImpl(CHAT_MESSAGES_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ broadcaster_id: broadcasterId, sender_id: senderId, message }),
      })
      const { data } = await readJson(response)
      const result: unknown = Array.isArray(data) ? data[0] : undefined
      if (!isRecord(result) || typeof result.is_sent !== 'boolean') {
        throw new TwitchApiError(BAD_GATEWAY, 'Twitchのチャット送信の応答に is_sent がありません')
      }
      // Twitchは受け取ったうえで送らないことがある（AutoModの保留など）。200だからと成功扱いにしない
      if (!result.is_sent) throw new TwitchApiError(BAD_GATEWAY, `Twitchがチャットを送信しませんでした: ${readDropReason(result.drop_reason)}`)
    },

    startDeviceAuthorization: async (scopes) => {
      const response = await fetchImpl(DEVICE_URL, {
        method: 'POST',
        body: new URLSearchParams({ client_id: clientId, scopes: scopes.join(' ') }),
      })
      return toDeviceAuthorization(await readJson(response))
    },

    exchangeDeviceCode: async (deviceCode, scopes) => {
      const response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        // Twitchのドキュメントの例には client_secret が無いが、それは秘密を持てない種類のアプリ（public）の場合。
        // このアプリは秘密を持つ種類（confidential）なので、ほかのトークン取得と同じように添える
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          scopes: scopes.join(' '),
          device_code: deviceCode,
          grant_type: DEVICE_CODE_GRANT_TYPE,
        }),
      })
      if (!response.ok) {
        const body: unknown = await response.clone().json().catch(() => null)
        const message = isRecord(body) && typeof body.message === 'string' ? body.message : ''
        if (PENDING_MESSAGES.includes(message)) return { status: 'pending' }
        // 待っている状態ではない失敗（期限切れ・拒否・設定の誤り）は、readJson に TwitchApiError を投げさせる
      }
      return { status: 'granted', grant: toTokenGrant(await readJson(response)) }
    },
  }
}
