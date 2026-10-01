/**
 * タブの映像の連絡の経路（送り手である拡張から呼ばれる）
 *
 * 送り手（拡張の offscreen document）を、連絡の中継先（worker/tab-channel.ts）へつなぐための入口である。
 * 合成ページ側の入口は、守り方がセッションではなくオーバーレイ用キーなので worker/overlay-routes.ts に置く
 * （手書きと同じ置き分け）。映像と音そのものは同じPCの中を WebRTC で流れ、Workerは通らない。
 * 配信者が /tab/ からダウンロードする Chrome 拡張の zip（GET /api/admin/tab/extension.zip）もここに置く。
 */
import { SENDER_PROTOCOL } from '../src/tab/signal'
import { HttpError, STATUS, requireSession, type Context } from './http'
import { verifySessionToken } from './session'
import { EXTENSION_ID } from '../extension/src/identity'
import { connectTabSocket } from './tab-channel'
import { EXTENSION_FOLDER, buildExtensionZip } from './tab-extension'

/** 送り手として受け入れる接続元（manifest.json の key で固定した HDAD の拡張） */
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`

/**
 * WebSocket のプロトコルの欄（Sec-WebSocket-Protocol）から、送り手が渡したセッションを取り出す。
 *
 * @returns [SENDER_PROTOCOL, セッション] の形でなければ null（クッキーで確かめる）
 */
const senderSessionOf = (request: Request): string | null => {
  const [name, session, ...rest] = (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map((part) => part.trim())
  return name === SENDER_PROTOCOL && session !== undefined && session !== '' && rest.length === 0 ? session : null
}

/**
 * 配信者本人のセッションを確かめる。プロトコルの欄で渡されていればそれを、無ければクッキーを確かめる。
 *
 * @returns プロトコルの欄で受け取ったなら true（応答でプロトコルの名前を応え返す必要がある）
 * @throws HttpError どちらでも配信者本人のセッションが確かめられない場合（401）
 */
const requireSenderSession = async (context: Context): Promise<boolean> => {
  const session = senderSessionOf(context.request)
  if (session === null) {
    await requireSession(context)
    return false
  }
  if ((await verifySessionToken(session, context.env.SESSION_SECRET, context.now)) !== context.env.TWITCH_BROADCASTER_ID) {
    throw new HttpError(STATUS.unauthorized, 'unauthorized', 'ログインが必要です。Chrome で HDAD を開いてログインし直してください')
  }
  return true
}

/**
 * GET /api/admin/tab/socket: 拡張の offscreen document からのWebSocketの接続を、送り手として中継先へ引き渡す。
 *
 * 拡張の offscreen document からの WebSocket には配信者のクッキーが付かない（拡張がこの置き場所への権限を持っていても付かないことを
 * 実機で確かめた）。そこで拡張は chrome.cookies で読んだセッションをプロトコルの欄で渡し（src/tab/signal.ts の SENDER_PROTOCOL）、
 * ここでクッキーと同じように確かめる。
 *
 * 注意: WebSocketの接続はGETなので、書き換えを伴うメソッドにだけ効く送信元の確認（requireAdmin）が働かない。
 * Origin が HDAD の拡張であることを自分で確かめる（別サイトや別の拡張に開かせた接続が送り手を名乗り、
 * 配信画面へ別の映像を送り込めないようにする）。
 */
export const tabSocket = async (context: Context): Promise<Response> => {
  const viaProtocol = await requireSenderSession(context)
  if (context.request.headers.get('Origin') !== EXTENSION_ORIGIN) {
    throw new HttpError(STATUS.forbidden, 'cross-origin', 'HDAD のタブの映像の拡張からの接続だけを受け付けます')
  }
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  const response = await connectTabSocket(context.env.TAB, context.request, true)
  if (!viaProtocol) return response
  // ブラウザは、頼んだプロトコルのどれかを応え返されないと接続を失敗させる。セッションの値は応え返さない
  const headers = new Headers(response.headers)
  headers.set('Sec-WebSocket-Protocol', SENDER_PROTOCOL)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers, webSocket: response.webSocket })
}

/**
 * GET /api/admin/tab/extension.zip: 配信者が Chrome に読み込む拡張を、この置き場所につなぐ設定と権限を入れて返す。
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
