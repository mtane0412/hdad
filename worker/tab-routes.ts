/**
 * タブの映像の連絡の経路（送り手である拡張から呼ばれる）
 *
 * 送り手（拡張の offscreen document）を、連絡の中継先（worker/tab-channel.ts）へつなぐための入口である。
 * 合成ページ側の入口は、守り方がセッションではなくオーバーレイ用キーなので worker/overlay-routes.ts に置く
 * （手書きと同じ置き分け）。映像と音そのものは同じPCの中を WebRTC で流れ、Workerは通らない。
 * 配信者が /tab/ からダウンロードする Chrome 拡張の zip（GET /api/admin/tab/extension.zip）と、
 * 映さないサイトの一覧（/api/admin/tab/blocked-hosts。worker/tab-blocked-hosts.ts）もここに置く。
 */
import { SENDER_PROTOCOL } from '../src/tab/signal'
import { HttpError, STATUS, requireAdmin, requireSession, type Context } from './http'
import { verifySessionToken } from './session'
import { EXTENSION_ID } from '../extension/src/identity'
import { connectTabSocket } from './tab-channel'
import { addBlockedHost, loadBlockedHosts, removeBlockedHost } from './tab-blocked-hosts'
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
 * 拡張が自分で読んで渡したセッションの値が、配信者本人のものか確かめる。
 *
 * @throws HttpError 配信者本人のセッションでない場合（401）
 */
const requireBroadcasterToken = async (session: string, context: Context): Promise<void> => {
  if ((await verifySessionToken(session, context.env.SESSION_SECRET, context.now)) !== context.env.TWITCH_BROADCASTER_ID) {
    throw new HttpError(STATUS.unauthorized, 'unauthorized', 'ログインが必要です。Chrome で HDAD を開いてログインし直してください')
  }
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
  await requireBroadcasterToken(session, context)
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

/** 拡張がセッションを渡すときの Authorization ヘッダーの書き出し */
const BEARER_PREFIX = 'Bearer '

/**
 * 拡張のサービスワーカーか、配信者がログインしたブラウザ（クッキー）からの呼び出しであることを確かめる。
 *
 * 拡張は chrome.cookies で読んだセッションを Authorization ヘッダーで渡す（拡張からの通信にクッキーが付くかを当てにしない。
 * offscreen document からの WebSocket には付かなかったため）。ヘッダーが無ければクッキーと送信元を確かめる。
 *
 * 注意: Authorization ヘッダーの経路では送信元（Origin）を確かめない。ブラウザは Authorization ヘッダーを自動では付けず、
 * セッションのクッキーは HttpOnly でページのスクリプトから読めないので、別サイトに書き換えさせる（CSRF）ことはできないため。
 *
 * @throws HttpError 配信者本人のセッションが確かめられない場合（401）・クッキーで別サイトから書き換えようとした場合（403）
 */
const requireExtensionOrAdmin = async (context: Context): Promise<void> => {
  const authorization = context.request.headers.get('Authorization')
  if (authorization === null) {
    await requireAdmin(context)
    return
  }
  if (!authorization.startsWith(BEARER_PREFIX)) {
    throw new HttpError(STATUS.unauthorized, 'unauthorized', 'Authorization ヘッダーは Bearer の形で渡してください')
  }
  await requireBroadcasterToken(authorization.slice(BEARER_PREFIX.length), context)
}

/** GET /api/admin/tab/blocked-hosts: 映さないサイトの一覧（拡張が映し始めるたびと、設定ページを開いたときに読む） */
export const getTabBlockedHosts = async (context: Context): Promise<Response> => {
  await requireExtensionOrAdmin(context)
  return Response.json({ hosts: await loadBlockedHosts(context.env.STORE) })
}

/** POST /api/admin/tab/blocked-hosts: ホスト名（{ host }）を一覧に加える（拡張の右クリックと設定ページから呼ばれる） */
export const postTabBlockedHost = async (context: Context): Promise<Response> => {
  await requireExtensionOrAdmin(context)
  const body: unknown = await context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const host = typeof body === 'object' && body !== null && 'host' in body ? body.host : undefined
  return Response.json({ hosts: await addBlockedHost(context.env.STORE, host) })
}

/** DELETE /api/admin/tab/blocked-hosts/:host: ホスト名を一覧から外す（拡張の右クリックと設定ページから呼ばれる） */
export const deleteTabBlockedHost = async (context: Context): Promise<Response> => {
  await requireExtensionOrAdmin(context)
  return Response.json({ hosts: await removeBlockedHost(context.env.STORE, context.params.host ?? '') })
}
