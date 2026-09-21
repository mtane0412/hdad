/**
 * チャットボットの管理用の経路（/api/admin/bot・/api/admin/bot/messages）
 *
 * 配信者のセッションが必要。botアカウントの接続状態の確認・切断と、管理画面からの手打ちのチャット送信を受け持つ。
 * botの接続そのもの（Twitchの認可画面への往復）は auth-routes.ts が受け持つ。
 *
 * 注意: botのトークンは応答に含めない。管理画面に返すのは、接続しているアカウントの見分けがつく情報
 * （ログイン名・ユーザーID）と、接続し直しが要るかを判断するための不足スコープだけにする。
 */
import { BOT_SCOPES } from './eventsub'
import { HttpError, STATUS, requireAdmin, type Context } from './http'
import { deleteToken, getAccessToken, loadToken } from './token'

/** Twitchが決めているチャット本文の上限（文字） */
const MAX_MESSAGE_LENGTH = 500

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

/** GET /api/admin/bot: botの接続状態。未接続なら bot は null */
export const getBot = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const token = await loadToken(context.env.STORE, 'bot')
  if (!token) return Response.json({ bot: null })

  return Response.json({
    bot: {
      userId: token.userId,
      login: token.login,
      missingScopes: BOT_SCOPES.filter((scope) => !token.scopes.includes(scope)),
    },
  })
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
  const { request, env, twitch, now } = context
  const message = await readMessage(request)

  const token = await getAccessToken(env.STORE, 'bot', twitch, now)
  await twitch.sendChatMessage(token.accessToken, {
    broadcasterId: env.TWITCH_BROADCASTER_ID,
    senderId: token.userId,
    message,
  })
  return new Response(null, { status: STATUS.noContent })
}
