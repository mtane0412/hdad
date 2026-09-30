/**
 * 手書きの線の中継（Durable Object）
 *
 * 配信者が描く画面（/draw/）で引いた線を、OBSに載っている合成ページへその場で届ける。Workerは接続を
 * 保持できないので、接続を保持できる Durable Object を1つだけ置き、描く画面と合成ページの両方がここへつなぐ。
 *
 * アラートの配送（worker/alert-channel.ts）と分けてあるのは、向きも量も違うためである。アラートは
 * 「Workerが押し出し、DOは配るだけ」だが、手書きは接続から届いたものを他の接続へ中継する。しかも1本の線を
 * 引くあいだに毎秒20〜30通が流れるので、同じDOに通すとアラートの配送がこの負荷を被る。
 *
 * この Durable Object は中身を読まない。届いた文字列をそのまま配り、形が正しいかは受け取った側
 * （src/draw/stroke.ts の parseDrawMessage）が確かめる。
 *
 * 描ける接続と見るだけの接続は、受け入れるときの目印（タグ）で分ける。合成ページが使うオーバーレイ用キーは
 * 配信画面に映りうるため、それを持つだけでは他人の画面に描けないようにする。どちらとして受け入れるかは
 * Workerが決める（worker/draw-routes.ts）。
 *
 * 接続は Hibernation API（ctx.acceptWebSocket）で受ける。つないだままでも待っている間は課金されないため、
 * 配信中ずっとつなぎっぱなしにできる。つないでいる間の合図（ping）には ctx.setWebSocketAutoResponse が
 * この Durable Object を起こさずに応える。
 *
 * 描いたものを貯めないので、合成ページを開いていない間に引いた線は届かない（残す仕組みは Phase 3 で追加する）。
 *
 * 注意: WebSocketの接続（Upgrade）は Cloudflare のランタイムでしか作れないので、テストでは中継の部分だけを確かめる。
 */
import { STATUS } from './http'
import { broadcast, type SocketLike } from './socket-broadcast'

/** Durable Object の名前。中継先は1つだけなので、決め打ちの名前で同じものを指す */
const CHANNEL_NAME = 'draw'

/** 描く画面からの接続に付ける目印。この接続から届いたものだけを中継する */
export const WRITER = 'writer'
/** 合成ページからの接続に付ける目印。受け取るだけで、送ってきても中継しない */
export const VIEWER = 'viewer'

/** 描く側として受け入れてよいかを Worker が伝えるためのクエリ。外には出ない（守りは Worker が済ませている） */
const ROLE_PARAM = 'role'

/** 眠ったまま応えられる合図と、それに返す合図 */
const PING = 'ping'
const PONG = 'pong'

/** 中継する相手。テストで差し替えられるよう、使うものだけを受け取る */
export type DrawSocket = SocketLike

/**
 * Durable Object から使う、接続の保持の仕組み。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * Cloudflare の DurableObjectState はこの形を満たす。
 */
export interface DrawChannelState {
  acceptWebSocket(socket: WebSocket, tags?: string[]): void
  getWebSockets(): DrawSocket[]
  getTags(socket: DrawSocket): string[]
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void
}

/**
 * Worker が Durable Object を呼ぶための入口。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * Cloudflare の DurableObjectNamespace はこの形を満たす。
 */
export interface DrawChannelNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> }
}

/** 描く画面と合成ページのあいだで手書きの線を中継する Durable Object */
export class DrawChannel {
  /** Cloudflare は (state, env) の2つを渡すが、この Durable Object は保管も外部との通信も行わないので state だけを受け取る */
  constructor(private readonly ctx: DrawChannelState) {}

  fetch(request: Request): Response {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response(null, { status: STATUS.notFound })
    return this.accept(new URL(request.url).searchParams.get(ROLE_PARAM) === WRITER ? WRITER : VIEWER)
  }

  /** 接続を受け取り、片方を返す。Hibernation API で受けるので、待っている間は課金されない */
  private accept(role: string): Response {
    // つないでいる間の合図（ping）には、この Durable Object を起こさずに応える（起こすと待っている間も課金される）
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG))
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server, [role])
    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * 接続から届いたものを、送り主以外の接続へそのまま配る。
   *
   * 送り主自身へ返さないのは、描く画面が自分のキャンバスへ直接描いているためである（返すと同じ線を二重に持つ）。
   */
  webSocketMessage(socket: DrawSocket, message: string | ArrayBuffer): void {
    // 描く画面は文字列しか送らない。それ以外が届いたら送り手の作りを疑うので、中継しない
    if (typeof message !== 'string') return
    // 見るだけの接続から送られてきたものは中継しない（オーバーレイ用キーだけでは描けないようにする）
    if (!this.ctx.getTags(socket).includes(WRITER)) return
    broadcast(
      this.ctx.getWebSockets().filter((peer) => peer !== socket),
      message,
      '手書きの線',
    )
  }
}

/** 中継先（1つだけ）を指す */
const channelOf = (namespace: DrawChannelNamespace): { fetch(request: Request): Promise<Response> } => namespace.get(namespace.idFromName(CHANNEL_NAME))

/**
 * WebSocketの接続を Durable Object へ引き渡す。
 *
 * 描く側として受け入れてよいか（配信者のセッションで守られた経路から来たか）の確認は、呼び出し側
 * （draw-routes.ts・overlay-routes.ts）が済ませている。
 *
 * @param writable 描く側として受け入れるなら true
 */
export const connectDrawSocket = (namespace: DrawChannelNamespace, request: Request, writable: boolean): Promise<Response> => {
  const url = new URL(request.url)
  url.searchParams.set(ROLE_PARAM, writable ? WRITER : VIEWER)
  return channelOf(namespace).fetch(new Request(url, request))
}
