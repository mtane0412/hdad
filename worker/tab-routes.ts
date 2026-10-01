/**
 * タブの映像の連絡の経路（送り手のページから呼ばれる）
 *
 * 配信者が開いておく送り手のページ（/tab/）を、連絡の中継先（worker/tab-channel.ts）へつなぐための入口である。
 * 合成ページ側の入口は、守り方がセッションではなくオーバーレイ用キーなので worker/overlay-routes.ts に置く
 * （手書きと同じ置き分け）。映像と音そのものは同じPCの中を WebRTC で流れ、Workerは通らない。
 */
import { HttpError, STATUS, requireSession, type Context } from './http'
import { connectTabSocket } from './tab-channel'

/**
 * GET /api/admin/tab/socket: 送り手のページからのWebSocketの接続を、送り手として中継先へ引き渡す。
 *
 * 注意: WebSocketの接続はGETなので、書き換えを伴うメソッドにだけ効く送信元の確認（requireAdmin）が働かない。
 * 手書き（worker/draw-routes.ts）と同じく Origin を自分でも確かめる（別サイトに開かせた接続が送り手を名乗り、
 * 配信画面へ別の映像を送り込めないようにする）。
 */
export const tabSocket = async (context: Context): Promise<Response> => {
  await requireSession(context)
  if (context.request.headers.get('Origin') !== context.url.origin) {
    throw new HttpError(STATUS.forbidden, 'cross-origin', '管理画面と同じサイトからの接続だけを受け付けます')
  }
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectTabSocket(context.env.TAB, context.request, true)
}
