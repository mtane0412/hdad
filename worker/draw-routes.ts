/**
 * 手書きの線の経路（描く画面から呼ばれる）
 *
 * 配信者が描く画面（/draw/）で引いた線を中継先（worker/draw-channel.ts）へ届けるための入口である。
 * 合成ページ側の入口は、守り方がセッションではなくオーバーレイ用キーなので worker/overlay-routes.ts に置く
 * （注目コメントと同じ置き分け）。
 */
import { connectDrawSocket } from './draw-channel'
import { HttpError, STATUS, requireSession, type Context } from './http'

/**
 * GET /api/admin/draw/socket: 描く画面からのWebSocketの接続を、描く側として中継先へ引き渡す。
 *
 * 注意: WebSocketの接続はGETなので、書き換えを伴うメソッドにだけ効く送信元の確認（requireAdmin）が働かない。
 * クッキーは SameSite=Lax で別サイトからのGETにも付きうるため、ここで Origin を自分で確かめる
 * （別サイトに開かせた接続から配信画面へ描かれないようにする）。
 */
export const drawSocket = async (context: Context): Promise<Response> => {
  await requireSession(context)
  if (context.request.headers.get('Origin') !== context.url.origin) {
    throw new HttpError(STATUS.forbidden, 'cross-origin', '管理画面と同じサイトからの接続だけを受け付けます')
  }
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectDrawSocket(context.env.DRAW, context.request, true)
}
