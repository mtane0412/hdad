/**
 * アラートの配送（Durable Object）
 *
 * Twitchからの通知はWebhookでWorkerに届くが、Workerは接続を保持できないため、オーバーレイ（OBSのブラウザソース）へ
 * 自分から知らせる手だてがない。そこで接続を保持できる Durable Object を1つだけ置き、オーバーレイはそこへ
 * WebSocketでつなぎ、Workerは当てはまったアラートをそこへ押し出す。
 *
 * この Durable Object は「配送者」であって「判定者」ではない。どのトリガーに当てはまるかは Worker（alert-event.ts）が決め、
 * ここは受け取ったアラートをそのまま開いている接続へ配るだけである。設定をここに持たせると、
 * 管理画面での変更がOBSの再読み込みなしで反映される性質が壊れる。
 *
 * 接続は Hibernation API（ctx.acceptWebSocket）で受ける。つないだままでも待っている間は課金されないため、
 * 配信中ずっとつなぎっぱなしにできる（無料枠の Duration を使い切らない）。
 * オーバーレイから届く ping には ctx.setWebSocketAutoResponse が起こさずに応える。
 *
 * オーバーレイを開いていない間に届いたアラートは、貯めずに落とす（配信していないときの分が後からまとめて流れないため）。
 *
 * 注意: WebSocketの接続（Upgrade）は Cloudflare のランタイムでしか作れないので、テストでは配送の部分だけを確かめる。
 */
import type { OverlayAlert } from './alert-event'
import { STATUS } from './http'

/** Durable Object の名前。配送先は1つだけなので、決め打ちの名前で同じものを指す */
const CHANNEL_NAME = 'alerts'

/** Worker が押し出しに使うパス。外には出ない（オーバーレイ用キーの確認はWorkerが済ませている） */
const PUSH_PATH = '/push'

/** オーバーレイが送ってくる合図と、それに返す合図。Durable Object を起こさずに応えるために使う */
const PING = 'ping'
const PONG = 'pong'

/** 接続が壊れていたときに閉じる理由（WebSocketの「予期しない状況」を表す番号） */
const INTERNAL_ERROR = 1011

/**
 * アラートの送り先。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * Cloudflare の WebSocket はこの形を満たす。
 */
export interface AlertSocket {
  send(message: string): void
  close(code?: number, reason?: string): void
}

/**
 * Durable Object から使う、接続の保持の仕組み。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * Cloudflare の DurableObjectState はこの形を満たす。
 */
export interface AlertChannelState {
  acceptWebSocket(socket: WebSocket): void
  getWebSockets(): AlertSocket[]
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void
}

/**
 * Worker が Durable Object を呼ぶための入口。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * Cloudflare の DurableObjectNamespace はこの形を満たす。
 */
export interface AlertChannelNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> }
}

/**
 * 開いている接続すべてへ同じ文字列を送る。
 *
 * 1本が壊れていても残りへは送る（1人の視聴環境の都合で配信全体のアラートを止めない）。
 * 送れなかった接続は閉じる。閉じないと、次のアラートでも同じ失敗を繰り返す。
 *
 * @returns 送れた接続の数
 */
export const broadcast = (sockets: readonly AlertSocket[], payload: string): number => {
  let delivered = 0
  for (const socket of sockets) {
    try {
      socket.send(payload)
      delivered += 1
    } catch (error) {
      console.error('アラートを配れませんでした', error)
      try {
        socket.close(INTERNAL_ERROR, 'アラートを配れませんでした')
      } catch {
        // 閉じることもできない接続は、Cloudflare側で片付けられるのを待つほかない
      }
    }
  }
  return delivered
}

/**
 * アラートを配るだけの Durable Object。
 *
 * 呼ぶのは Worker だけで、次の2つを受け付ける。
 * - Upgrade: websocket のリクエスト: オーバーレイからの接続を受ける（パスはWorkerのものがそのまま届く）
 * - POST /push: Worker が押し出したアラートを、開いている接続すべてへ配る
 */
export class AlertChannel {
  /** Cloudflare は (state, env) の2つを渡すが、この Durable Object は保管も外部との通信も行わないので state だけを受け取る */
  constructor(private readonly ctx: AlertChannelState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') === 'websocket') return this.accept()
    if (new URL(request.url).pathname === PUSH_PATH) return this.push(await request.text())
    return new Response(null, { status: STATUS.notFound })
  }

  /** オーバーレイからの接続を受け取り、片方を返す。Hibernation API で受けるので、待っている間は課金されない */
  private accept(): Response {
    // つないでいる間の合図（ping）には、この Durable Object を起こさずに応える（起こすと待っている間も課金される）
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG))
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  /** 押し出されたアラートを、開いている接続すべてへ配る */
  private push(payload: string): Response {
    broadcast(this.ctx.getWebSockets(), payload)
    return new Response(null, { status: STATUS.noContent })
  }
}

/** 配送先（1つだけ）を指す */
const channelOf = (namespace: AlertChannelNamespace): { fetch(request: Request): Promise<Response> } =>
  namespace.get(namespace.idFromName(CHANNEL_NAME))

/**
 * オーバーレイからのWebSocketの接続を Durable Object へ引き渡す。
 *
 * オーバーレイ用キーの確認は呼び出し側（overlay-routes.ts）が済ませている。
 */
export const connectAlertSocket = (namespace: AlertChannelNamespace, request: Request): Promise<Response> => channelOf(namespace).fetch(request)

/**
 * 当てはまったアラートを Durable Object へ押し出す。
 *
 * 注意: 失敗を黙って握りつぶさない。呼び出し側（webhook-routes.ts）が収集の失敗として記録し、
 * 管理画面から気づけるようにする。
 */
export const pushAlert = async (namespace: AlertChannelNamespace, alert: OverlayAlert): Promise<void> => {
  const response = await channelOf(namespace).fetch(
    new Request(`https://alert-channel${PUSH_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(alert) }),
  )
  if (!response.ok) throw new Error(`アラートを配送先へ送れませんでした（${response.status}）`)
}
