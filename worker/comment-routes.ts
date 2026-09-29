/**
 * コメントビューアーの経路（/api/admin/comments/*）
 *
 * 配信中のチャットと出来事を並べる画面（/comments/）から呼ばれる。
 * - GET /api/admin/comments/socket: 画面からのWebSocketの接続を、配送先（worker/comment-channel.ts）へ引き渡す
 * - GET /api/admin/comments/icons: 発言した人のアイコンのURLを、ユーザーIDからまとめて引く
 *
 * アイコンを1件ごとに添えて配らないのは、チャットの発言のたびに Twitch を呼ぶことになるためである。
 * 画面が初めて見た人のIDだけをまとめて問い合わせ、画面を開いているあいだ手元に覚えておく。
 */
import { connectCommentSocket } from './comment-channel'
import { HttpError, STATUS, requireAdmin, requireSession, type Context } from './http'

/** 1度に引けるアイコンの人数（Twitch の GET /helix/users が1度に受け付ける上限） */
export const MAX_ICON_USERS = 100

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
