/**
 * コメントビューアーの経路（/api/admin/comments/*）
 *
 * 配信中のチャットと出来事を並べる画面（/comments/）から呼ばれる。
 * - GET /api/admin/comments/socket: 画面からのWebSocketの接続を、配送先（worker/comment-channel.ts）へ引き渡す
 * - GET /api/admin/comments/icons: 発言した人のアイコンのURLを、ユーザーIDからまとめて引く
 * - POST /api/admin/comments/moderation: 配信者が選んだ処分（発言の削除・タイムアウト・BAN）を、botの権限で行う
 *
 * アイコンを1件ごとに添えて配らないのは、チャットの発言のたびに Twitch を呼ぶことになるためである。
 * 画面が初めて見た人のIDだけをまとめて問い合わせ、画面を開いているあいだ手元に覚えておく。
 */
import { punishAsBot, type PunishTarget } from './bot-moderation'
import type { Punishment } from './chat-moderation'
import { connectCommentSocket } from './comment-channel'
import { HttpError, STATUS, requireAdmin, requireSession, type Context } from './http'

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
