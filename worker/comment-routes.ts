/**
 * コメントビューアーの経路（/api/admin/comments/*）
 *
 * 配信中のチャットと出来事を並べる画面（/comments/）から呼ばれる。
 * - GET /api/admin/comments/socket: 画面からのWebSocketの接続を、配送先（worker/comment-channel.ts）へ引き渡す
 * - GET /api/admin/comments/icons: 発言した人のアイコンのURLを、ユーザーIDからまとめて引く
 * - POST /api/admin/comments/moderation: 配信者が選んだ処分（発言の削除・タイムアウト・BAN）を、botの権限で行う
 * - POST /api/admin/comments/messages: 配信者本人としてチャットへ送る
 * - POST /api/admin/comments/reads: 発言を既読にする・未読に戻す
 * - GET/PUT /api/admin/comments/settings: コメントビューアーの設定（しばらく未読の発言を目立たせるか）を読み書きする
 *
 * アイコンを1件ごとに添えて配らないのは、チャットの発言のたびに Twitch を呼ぶことになるためである。
 * 画面が初めて見た人のIDだけをまとめて問い合わせ、画面を開いているあいだ手元に覚えておく。
 */
import { punishAsBot, type PunishTarget } from './bot-moderation'
import { readMessageToSend } from './bot-routes'
import type { Punishment } from './chat-moderation'
import { connectCommentSocket, pushFeedItem } from './comment-channel'
import { loadCommentSettings, parseCommentSettings, saveCommentSettings } from './comment-config'
import { recordCommentRead } from './comment-read-store'
import { HttpError, STATUS, requireAdmin, requireSession, type Context } from './http'
import { AuthError, getAccessToken } from './token'

/** 1度に引けるアイコンの人数（Twitch の GET /helix/users が1度に受け付ける上限） */
export const MAX_ICON_USERS = 100

/**
 * コメントビューアーから行うタイムアウトの長さ（秒）。
 *
 * 配信中に長さを選ばせず、1つに決めておく（Twitch の /timeout の既定と同じ10分）。画面はこの値を応答から受け取って表示する。
 */
export const MANUAL_TIMEOUT_SECONDS = 600

/** Twitchのモデレーターの記録に残る理由。自動モデレーションと見分けられるようにする */
const MANUAL_MODERATION_REASON = '配信者がコメントビューアーから処分'

/** Twitch のユーザーIDの形（数字だけ） */
const USER_ID_PATTERN = /^\d+$/

/**
 * GET /api/admin/comments/socket: 画面からのWebSocketの接続を配送先へ引き渡す。
 *
 * 注意: WebSocketの接続はGETなので、書き換えを伴うメソッドにだけ効く送信元の確認（requireAdmin）が働かない。
 * 手書きの接続（draw-routes.ts の drawSocket）と同じく、Origin を自分でも確かめる
 * （別サイトに開かせた接続から、視聴者のチャットを読み取られないようにする）。
 */
export const commentSocket = async (context: Context): Promise<Response> => {
  await requireSession(context)
  if (context.request.headers.get('Origin') !== context.url.origin) {
    throw new HttpError(STATUS.forbidden, 'cross-origin', '管理画面と同じサイトからの接続だけを受け付けます')
  }
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectCommentSocket(context.env.COMMENTS, context.request)
}

/**
 * GET /api/admin/comments/icons?user_id=…&user_id=…: ユーザーIDごとのアイコンのURLを返す。
 *
 * Twitch が返さなかった人（消えたアカウントなど）は結果に含めない（画面はアイコンなしで並べる）。
 *
 * @throws HttpError ユーザーIDが無い・数字でない・上限を超える場合（400）
 * @throws TwitchApiError アイコンを引けなかった場合（index.ts が502にする）
 */
export const getCommentIcons = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const userIds = context.url.searchParams.getAll('user_id')
  if (userIds.length === 0 || userIds.length > MAX_ICON_USERS || !userIds.every((userId) => USER_ID_PATTERN.test(userId))) {
    throw new HttpError(STATUS.badRequest, 'invalid-user-ids', `user_id には数字のユーザーIDを1〜${MAX_ICON_USERS}個指定してください`)
  }
  const { twitch } = context
  return Response.json({ icons: await twitch.getProfileImageUrls(await twitch.getAppAccessToken(), userIds) })
}

/** 画面から選べる処分 */
const MODERATION_ACTIONS = ['delete', 'timeout', 'ban'] as const
type ModerationAction = (typeof MODERATION_ACTIONS)[number]

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isModerationAction = (value: unknown): value is ModerationAction => MODERATION_ACTIONS.some((action) => action === value)

/**
 * 本文から、処分の種類と対象を読む。
 *
 * タイムアウト・BANでは発言を先に削除しない（messageId を null にする）。Twitch はタイムアウト・BANした人の発言を
 * まとめて消すうえ、自動モデレーションや別のモデレーターがすでに消した発言を指定すると削除が失敗し、処分まで届かないため。
 *
 * @throws HttpError 操作が知らないもの・項目が欠けている（400）
 */
const readModerationRequest = (body: unknown): { action: ModerationAction; punishment: Punishment; target: PunishTarget } => {
  const { action, messageId, userId } = isRecord(body) ? body : {}
  if (!isModerationAction(action) || typeof messageId !== 'string' || messageId === '' || typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) {
    throw new HttpError(STATUS.badRequest, 'invalid-body', `本文は { action: ${MODERATION_ACTIONS.join('・')}, messageId, userId（数字） } にしてください`)
  }
  switch (action) {
    case 'delete':
      return { action, punishment: { type: 'delete' }, target: { messageId, userId } }
    case 'timeout':
      return { action, punishment: { type: 'timeout', durationSeconds: MANUAL_TIMEOUT_SECONDS }, target: { messageId: null, userId } }
    case 'ban':
      return { action, punishment: { type: 'ban' }, target: { messageId: null, userId } }
  }
}

/**
 * POST /api/admin/comments/moderation: 配信者が選んだ処分を、botがモデレーターとして行う。
 *
 * 自動モデレーションと同じ実行部分（bot-moderation.ts の punishAsBot）を使う。botがこのチャンネルの
 * モデレーターでなければ Twitch が拒否し、その理由を画面へ返す。タイムアウトなら、Workerが決めた長さを返す。
 *
 * @throws HttpError 本文が想定と違う（400）
 * @throws AuthError botが未接続・トークンを更新できない（index.ts が401にする）
 * @throws TwitchApiError Twitchが拒否した（index.ts が502にする）
 */
export const postCommentModeration = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body: unknown = await context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const { action, punishment, target } = readModerationRequest(body)
  await punishAsBot(context, punishment, target, MANUAL_MODERATION_REASON)
  return Response.json(punishment.type === 'timeout' ? { action, durationSeconds: punishment.durationSeconds } : { action })
}

/** 配信者本人としてチャットを送るために、配信者のトークンに要るスコープ */
const WRITE_CHAT_SCOPE = 'user:write:chat'

/**
 * POST /api/admin/comments/messages: 配信者本人としてチャットへ1通送る。
 *
 * 注意: 配信者がまだ user:write:chat を許可していない（スコープを追加する前にログインしたまま）なら、
 * 黙ってbotで代わりに送らず、ログインし直すよう伝える（送り主が違う発言を配信者の発言として出さないため）。
 *
 * @throws HttpError 本文が空・長すぎる（400）
 * @throws AuthError 配信者が未ログイン・トークンを更新できない・user:write:chat が無い（index.ts が401にする）
 * @throws TwitchApiError Twitchが拒否した、または受け取ったうえで送信しなかった（AutoModの保留など。index.ts が502にする）
 */
export const postCommentMessage = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const message = await readMessageToSend(context.request)
  const { env, twitch, now } = context
  const token = await getAccessToken(env.STORE, 'broadcaster', twitch, now)
  if (!token.scopes.includes(WRITE_CHAT_SCOPE)) {
    throw new AuthError('missing-scope', `配信者のトークンに ${WRITE_CHAT_SCOPE} がありません。ログインし直してください（配信者としてチャットを送れません）`)
  }
  await twitch.sendChatMessage(token.accessToken, { broadcasterId: env.TWITCH_BROADCASTER_ID, senderId: env.TWITCH_BROADCASTER_ID, message })
  return new Response(null, { status: STATUS.noContent })
}

/**
 * 本文から、既読にする・未読に戻す発言を読む。
 *
 * @throws HttpError 発言のIDが無い・空、既読かどうかが真偽値でない（400）
 */
const readCommentReadRequest = (body: unknown): { messageId: string; read: boolean } => {
  const { messageId, read } = isRecord(body) ? body : {}
  if (typeof messageId !== 'string' || messageId === '' || typeof read !== 'boolean') {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文は { messageId, read（true か false） } にしてください')
  }
  return { messageId, read }
}

/**
 * POST /api/admin/comments/reads: 配信者が手で、発言を既読にする・未読に戻す。
 *
 * 記録（D1 の comment_reads）してから、配送先へ付け替えの1件を押し出す。押し出した1件は配送先の履歴にも残るので、
 * 開いているほかの画面にも同じ印が付き、開き直したときも履歴から印が戻る。付け替えの1件には毎回新しいIDを振る
 * （画面は同じIDの1件を二度当てはめないので、同じ発言を既読→未読と付け替えたときに2回目を捨てさせないため）。
 *
 * 注意: 押し出しに失敗したら成功として返さない。Webhook の押し出し（webhook-routes.ts）と違い、ここは
 * 付け替えそのものが目的の操作なので、画面に印が出ないまま成功に見せない。
 * 注意: 押し出しに失敗すると、記録（既読）と画面（未読のまま）が食い違ったままになる。取り消して揃えることはせず、
 * 画面が失敗を出し、配信者がもう一度押すことで揃える。記録は上書きなので同じ付け替えを何度送っても1行のままで、
 * 押し出しが通った時点で画面にも同じ印が付く。記録を先にするのは、逆の順だと画面には既読と出るのに記録が無く、
 * 配信者から食い違いが見えなくなるためである。
 *
 * @throws HttpError 本文が想定と違う（400）
 */
export const postCommentRead = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body: unknown = await context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const { messageId, read } = readCommentReadRequest(body)
  const { env, now } = context
  await recordCommentRead(env.DB, { messageId, read, by: 'manual' }, now)
  await pushFeedItem(env.COMMENTS, { kind: 'read', id: crypto.randomUUID(), at: now, messageId, read, by: 'manual' })
  return new Response(null, { status: STATUS.noContent })
}

/** GET /api/admin/comments/settings: コメントビューアーの設定。未保存なら既定の設定を返す */
export const getCommentSettings = async (context: Context): Promise<Response> => {
  await requireSession(context)
  return Response.json(await loadCommentSettings(context.env.STORE))
}

/**
 * PUT /api/admin/comments/settings: コメントビューアーの設定を検証して保存し、保存した設定を返す。
 *
 * @throws ConfigError 設定の形に問題がある場合（index.ts が問題点付きの400にする）
 */
export const putCommentSettings = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body: unknown = await context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const settings = parseCommentSettings(body)
  await saveCommentSettings(context.env.STORE, settings)
  return Response.json(settings)
}
