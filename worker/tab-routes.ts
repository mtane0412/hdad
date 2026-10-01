/**
 * タブの映像の連絡の経路（送り手のページから呼ばれる）
 *
 * 配信者が開いておく送り手のページ（/tab/）を、連絡の中継先（worker/tab-channel.ts）へつなぐための入口である。
 * 合成ページ側の入口は、守り方がセッションではなくオーバーレイ用キーなので worker/overlay-routes.ts に置く
 * （手書きと同じ置き分け）。映像と音そのものは同じPCの中を WebRTC で流れ、Workerは通らない。
 * 送り手のページから配信者がダウンロードする Chrome 拡張の zip（GET /api/admin/tab/extension.zip）もここに置く。
 */
import { HttpError, STATUS, requireSession, type Context } from './http'
import { connectTabSocket } from './tab-channel'
import { EXTENSION_FOLDER, buildExtensionZip } from './tab-extension'

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

/**
 * GET /api/admin/tab/extension.zip: 配信者が Chrome に読み込む拡張を、この置き場所を信頼する設定を入れて返す。
 *
 * 置き場所はリクエストの URL から取る（配信者がいま開いている HDAD そのものなので、書き間違いが起きない）。
 * 拡張に秘密は入っていないが、ほかの管理用の機能と同じく配信者のセッションで守る。
 */
export const tabExtensionZip = async (context: Context): Promise<Response> => {
  await requireSession(context)
  const zip = await buildExtensionZip(context.env.ASSETS, context.url.origin)
  return new Response(zip, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${EXTENSION_FOLDER}.zip"`,
      // 置き場所ごとに中身が変わるので、途中の経路に残させない
      'Cache-Control': 'no-store',
    },
  })
}
