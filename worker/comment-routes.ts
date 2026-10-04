/**
 * コメントビューアーの経路（/api/admin/comments/*）
 *
 * 配信中のチャットと出来事を並べる画面（/comments/）から呼ばれる。
 * - GET /api/admin/comments/socket: 画面からのWebSocketの接続を、配送先（worker/comment-channel.ts）へ引き渡す
 * - GET /api/admin/comments/icons: 発言した人のアイコンのURLを、ユーザーIDからまとめて引く
 * - POST /api/admin/comments/moderation: 配信者が選んだ処分（発言の削除・タイムアウト・BAN）を、botの権限で行う
 * - POST /api/admin/comments/messages: 配信者本人としてチャットへ送る
 * - POST /api/admin/comments/greetings: その配信で初めての発言に、挨拶した・挨拶していない状態に戻す
 *
 * アイコンを1件ごとに添えて配らないのは、チャットの発言のたびに Twitch を呼ぶことになるためである。
 * 画面が初めて見た人のIDだけをまとめて問い合わせ、画面を開いているあいだ手元に覚えておく。
 */
import { punishAsBot, type PunishTarget } from './bot-moderation'
import { readMessageToSend } from './bot-routes'
import type { Punishment } from './chat-moderation'
import { recordGreeting } from './chat-store'
import { connectCommentSocket, pushFeedItem } from './comment-channel'
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
  const token = await getAccessToken(env.TOKENS, 'broadcaster', twitch, now)
  if (!token.scopes.includes(WRITE_CHAT_SCOPE)) {
    throw new AuthError('missing-scope', `配信者のトークンに ${WRITE_CHAT_SCOPE} がありません。ログインし直してください（配信者としてチャットを送れません）`)
  }
  await twitch.sendChatMessage(token.accessToken, { broadcasterId: env.TWITCH_BROADCASTER_ID, senderId: env.TWITCH_BROADCASTER_ID, message })
  return new Response(null, { status: STATUS.noContent })
}

/**
 * 本文から、挨拶したかを付け替える初めての発言を読む。
 *
 * @throws HttpError 発言のIDが無い・空、挨拶したかどうかが真偽値でない（400）
 */
const readGreetingRequest = (body: unknown): { messageId: string; greeted: boolean } => {
  const { messageId, greeted } = isRecord(body) ? body : {}
  if (typeof messageId !== 'string' || messageId === '' || typeof greeted !== 'boolean') {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文は { messageId, greeted（true か false） } にしてください')
  }
  return { messageId, greeted }
}

/**
 * POST /api/admin/comments/greetings: その配信で初めての発言に、配信者が手で「挨拶した」を付ける・外す（issue #158）。
 *
 * 記録（D1 の first_chatters.greeted_at。chat-store.ts の recordGreeting）してから、配送先へ付け替えの1件を押し出す。
 * 押し出した1件は配送先の履歴にも残るので、開いているほかの画面にも同じ印が付き、開き直したときも履歴から印が戻る。
 * 付け替えの1件には毎回新しいIDを振る（画面は同じIDの1件を二度当てはめないので、挨拶した→戻すと付け替えたときに
 * 2回目を捨てさせないため）。
 *
 * 注意: 初めての発言として記録されていない発言なら、黙って成功にせず404で断る（画面と記録の食い違いに気づけるように）。
 * 注意: 押し出しに失敗したら成功として返さない。付け替えそのものが目的の操作なので、画面に印が出ないまま成功に見せない。
 * 記録は上書きなので、配信者がもう一度押せば、押し出しが通った時点で記録と画面が揃う。
 *
 * @throws HttpError 本文が想定と違う（400）・初めての発言として記録されていない（404）
 */
export const postCommentGreeting = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body: unknown = await context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const { messageId, greeted } = readGreetingRequest(body)
  const { env, now } = context
  if (!(await recordGreeting(env.DB, { messageId, greeted }, now))) {
    throw new HttpError(STATUS.notFound, 'unknown-first-chat', 'その配信で初めての発言として記録されていない発言です（配信が終わって記録が消えたか、2回目以降の発言です）')
  }
  await pushFeedItem(env.COMMENTS, { kind: 'greeting', id: crypto.randomUUID(), at: now, messageId, greeted })
  return new Response(null, { status: STATUS.noContent })
}
