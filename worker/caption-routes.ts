/**
 * 字幕の経路（アプリの枠から呼ばれる）
 *
 * アプリの枠の音声認識（src/transcript/recognition-context.tsx）が、暫定・確定の文を字幕の中継先へ送るための入口である
 * （issue #190）。中継先は手書きと同じ Durable Object のクラスを、別の名前（caption）で使う（worker/draw-channel.ts）。
 * 合成ページ側の入口は、守り方がセッションではなくオーバーレイ用キーなので worker/overlay-routes.ts に置く
 * （手書きと同じ置き分け）。
 *
 * 字幕は流れていくだけのものなので保存しない。確定した発話の記録は、これとは別に POST /api/admin/transcripts が受け持つ。
 */
import { connectDrawSocket } from './draw-channel'
import { HttpError, STATUS, requireSession, type Context } from './http'

/**
 * GET /api/admin/caption/socket: アプリの枠からのWebSocketの接続を、送る側として字幕の中継先へ引き渡す。
 *
 * 注意: WebSocketの接続はGETなので、書き換えを伴うメソッドにだけ効く送信元の確認（requireAdmin）が働かない。
 * 手書きの接続（draw-routes.ts の drawSocket）と同じく、Origin を自分でも確かめる
 * （別サイトに開かせた接続から配信画面へ字幕を出されないようにする）。
 */
export const captionSocket = async (context: Context): Promise<Response> => {
  await requireSession(context)
  if (context.request.headers.get('Origin') !== context.url.origin) {
    throw new HttpError(STATUS.forbidden, 'cross-origin', '管理画面と同じサイトからの接続だけを受け付けます')
  }
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectDrawSocket(context.env.DRAW, context.request, true, 'caption')
}
