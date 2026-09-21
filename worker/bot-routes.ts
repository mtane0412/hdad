/**
 * チャットボットの管理用の経路（/api/admin/bot・/api/admin/bot/messages・/api/admin/bot/device-*・/api/admin/bot/commands・/api/admin/bot/moderation）
 *
 * 配信者のセッションが必要。botアカウントの接続状態の確認・切断、管理画面からの手打ちのチャット送信、
 * そしてデバイスコードフローによる接続を受け持つ。
 *
 * botの接続には2つの道がある。
 * - 認可コードフロー（auth-routes.ts の /api/auth/login?role=bot）: 同じブラウザでTwitchのログインを切り替える
 * - デバイスコードフロー（ここ）: 別の端末（botでログイン済みのスマホなど）でコードを入力する。
 *   このアプリのログイン（配信者）とTwitchのログイン（bot）が別の端末に分かれるので、どちらも切り替えずに済む
 *
 * 注意: botのトークンは応答に含めない。管理画面に返すのは、接続しているアカウントの見分けがつく情報
 * （ログイン名・ユーザーID）と、接続し直しが要るかを判断するための不足スコープだけにする。
 */
import { sendAsBot } from './bot-chat'
import { loadBotConfig, parseBotConfig, saveBotConfig } from './bot-config'
import { BOT_SCOPES } from './eventsub'
import { syncWebhookSubscriptions } from './eventsub-webhook'
import { HttpError, STATUS, requireAdmin, type Context } from './http'
import { loadModerationConfig, parseModerationConfig, saveModerationConfig } from './moderation-config'
import { AuthError, deleteToken, getAccessToken, loadToken, saveToken, type StoredToken } from './token'

/** Twitchが決めているチャット本文の上限（文字） */
const MAX_MESSAGE_LENGTH = 500
const MILLISECONDS_PER_SECOND = 1000

/** 管理画面から送られてきた本文を取り出す。送れない本文はTwitchへ問い合わせる前に拒否する */
const readMessage = async (request: Request): Promise<string> => {
  const body: unknown = await request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const message = typeof body === 'object' && body !== null ? (body as { message?: unknown }).message : undefined
  if (typeof message !== 'string' || message.trim() === '') {
    throw new HttpError(STATUS.badRequest, 'invalid-message', 'message: 送る文言を入力してください')
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new HttpError(STATUS.badRequest, 'invalid-message', `message: ${MAX_MESSAGE_LENGTH}文字以内にしてください`)
  }
  return message
}

/** botがモデレーターかどうかを確かめるために、配信者のトークンに要るスコープ */
const MODERATION_READ_SCOPE = 'moderation:read'

/** 管理画面へ返す接続状態。トークンそのものは含めない */
const toBotStatus = (token: StoredToken, isModerator: boolean): Record<string, unknown> => ({
  userId: token.userId,
  login: token.login,
  missingScopes: BOT_SCOPES.filter((scope) => !token.scopes.includes(scope)),
  isModerator,
})

/**
 * botがこのチャンネルのモデレーターにされているかを、配信者のトークンで確かめる。
 *
 * モデレーターでないとBAN・タイムアウト・発言の削除・アナウンスがすべてTwitchに拒否されるため、
 * 管理画面で「配信者が /mod を実行してください」と案内できるようにする。
 *
 * 注意: スコープ不足を「モデレーターでない」と読み替えない。取り違えると、本当はモデレーターなのに
 * 案内が出続けることになる。
 *
 * @throws AuthError 配信者が未ログイン・moderation:read が無い
 * @throws TwitchApiError Twitchが拒否した
 */
const isBotModerator = async (context: Context, botUserId: string): Promise<boolean> => {
  const { env, twitch, now } = context
  const token = await getAccessToken(env.STORE, 'broadcaster', twitch, now)
  if (!token.scopes.includes(MODERATION_READ_SCOPE)) {
    throw new AuthError(
      'missing-scope',
      `配信者のトークンに ${MODERATION_READ_SCOPE} がありません。ログインし直してください（botがモデレーターかどうかを確かめられません）`,
    )
  }
  return twitch.isModerator(token.accessToken, { broadcasterId: env.TWITCH_BROADCASTER_ID, userId: botUserId })
}

/** GET /api/admin/bot: botの接続状態。未接続なら bot は null */
export const getBot = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const token = await loadToken(context.env.STORE, 'bot')
  if (!token) return Response.json({ bot: null })
  return Response.json({ bot: toBotStatus(token, await isBotModerator(context, token.userId)) })
}

/**
 * DELETE /api/admin/bot: botを切断する。
 *
 * 注意: Twitch側の認可の取り消しまでは行わない（それにはbot本人の操作が要る）。
 * このWorkerがトークンを持たなくなるだけで、botとしての読み書きは止まる。
 */
export const deleteBot = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  await deleteToken(context.env.STORE, 'bot')
  // botがいなくなるとチャットを購読できないので、購読を揃え直して消す
  await syncWebhookSubscriptions(context)
  return new Response(null, { status: STATUS.noContent })
}

/**
 * POST /api/admin/bot/messages: botの名前で配信者のチャンネルへメッセージを送る（動作確認用）。
 *
 * @throws AuthError botが未接続・トークンを更新できない
 * @throws TwitchApiError Twitchが拒否した、または受け取ったうえで送信しなかった（AutoModの保留など）
 */
export const postBotMessage = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const message = await readMessage(context.request)

  await sendAsBot(context, message)
  return new Response(null, { status: STATUS.noContent })
}

/**
 * POST /api/admin/bot/device-code: デバイスコードフローを始める。
 *
 * 返す deviceCode は、このあとの交換でそのまま送り返してもらうためのもので、管理画面の中だけで使う。
 * ストアに置かない理由は、KVの書き込みが他の拠点へ届くまで最大60秒かかり、直後のポーリングで
 * 見つからないことがあるため。RFC 8628 でも、device_code を持つのは認可を待っている装置（ここでは管理画面）である。
 *
 * @throws TwitchApiError Twitchが発行を断った
 */
export const postBotDeviceCode = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json(await context.twitch.startDeviceAuthorization(BOT_SCOPES))
}

/**
 * POST /api/admin/bot/device-token: デバイスコードをトークンに交換する。
 *
 * 利用者がまだ認可していなければ `{ status: 'pending' }`、問い合わせが速すぎれば `{ status: 'slow-down' }` を返す（どちらも失敗にしない）。
 * 管理画面はこれを見て待ち続け、slow-down なら次からの間隔を延ばす。
 *
 * @throws TwitchApiError コードの期限切れ・利用者が拒否・そのほかの失敗
 */
export const postBotDeviceToken = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { request, env, twitch, now } = context

  const body: unknown = await request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const deviceCode = typeof body === 'object' && body !== null ? (body as { deviceCode?: unknown }).deviceCode : undefined
  if (typeof deviceCode !== 'string' || deviceCode === '') {
    throw new HttpError(STATUS.badRequest, 'invalid-device-code', 'deviceCode: 接続をやり直してください')
  }

  const exchange = await twitch.exchangeDeviceCode(deviceCode, BOT_SCOPES)
  // まだ認可されていない。slow-down は「間隔を延ばして待つ」ことを管理画面へ伝えるため、pending と分けて返す
  if (exchange.status !== 'granted') return Response.json({ status: exchange.status })

  const { grant } = exchange
  // どのアカウントが認可したかは、トークンを検証しないと分からない（デバイスコードフローには戻り先がないため）
  const owner = await twitch.validate(grant.accessToken)
  const token: StoredToken = {
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    expiresAt: now + grant.expiresIn * MILLISECONDS_PER_SECOND,
    ...owner,
  }
  // モデレーターかどうかの確認は保存より先に行う。保存したあとに失敗すると、botは接続できているのに
  // 画面にはエラーだけが出て、状態が半端になる
  const isModerator = await isBotModerator(context, owner.userId)

  await saveToken(env.STORE, 'bot', token)
  // チャットの購読の条件にbotのユーザーIDが入るので、接続できた時点で揃え直す
  await syncWebhookSubscriptions(context)
  return Response.json({ status: 'connected', bot: toBotStatus(token, isModerator) })
}

/** GET /api/admin/bot/moderation: 保存済みの自動モデレーションの設定（未保存なら既定の無効の設定） */
export const getBotModeration = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json(await loadModerationConfig(context.env.STORE))
}

/**
 * PUT /api/admin/bot/moderation: 自動モデレーションの設定を検証して保存する。
 *
 * @throws ConfigError 設定に問題がある場合（index.ts が問題点付きの400にする）
 */
export const putBotModeration = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body: unknown = await context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const config = parseModerationConfig(body)
  await saveModerationConfig(context.env.STORE, config)
  return Response.json(config)
}

/** GET /api/admin/bot/commands: 保存済みのコマンドの一覧 */
export const getBotCommands = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json(await loadBotConfig(context.env.STORE))
}

/**
 * PUT /api/admin/bot/commands: コマンドを検証して保存する。
 *
 * @throws ConfigError 設定に問題がある場合（index.ts が問題点付きの400にする）
 */
export const putBotCommands = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body: unknown = await context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const config = parseBotConfig(body)
  await saveBotConfig(context.env.STORE, config)
  return Response.json(config)
}
