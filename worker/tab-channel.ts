/**
 * タブの映像をつなぐ連絡の中継（Durable Object）
 *
 * Chromeのタブの映像と音は、送り手（拡張 HDAD-tab）から合成ページ（素材 `tab`）へ WebRTC で同じPCの中を直接流れる。
 * Workerを通るのは、つなぐための連絡（offer・answer など。src/tab/signal.ts）だけである。
 * 送り手と合成ページは、どちらも接続を保持できるこの Durable Object へつなぐ。
 *
 * 手書きの中継（worker/draw-channel.ts）と分けてあるのは、向きが違うためである。手書きは描く画面から合成ページへの
 * 一方向だが、WebRTC の連絡は両方向に流れる（合成ページが名乗り、送り手が offer を送り、合成ページが answer を返す）。
 *
 * この Durable Object は中身を読まない。送り手から届いたものは合成ページ全員へ、合成ページから届いたものは送り手へ
 * そのまま配り、形が正しいか・自分あてかは受け取った側が確かめる。同じ側どうし（合成ページから合成ページ）には配らない。
 * オーバーレイ用キーは配信画面に映りうるため、それを持つだけで他の合成ページへ offer を送り込めないようにする。
 *
 * どちらとして受け入れるかは Worker が決める（送り手は配信者のセッション、合成ページはオーバーレイ用キー。worker/tab-routes.ts）。
 * 接続は Hibernation API（ctx.acceptWebSocket）で受け、つないでいる間の合図（ping）には眠ったまま応える。
 *
 * 注意: WebSocketの接続（Upgrade）は Cloudflare のランタイムでしか作れないので、テストでは中継の部分だけを確かめる。
 */
import { STATUS, errorResponse } from './http'
import { KEY_TAG_PARAM, isCurrentKeyTag, rememberKeyTag, revokeRequest, type DurableStorage } from './overlay-key'
import { broadcast, closeForRevokedKey, type SocketLike } from './socket-broadcast'

/** Durable Object の名前。中継先は1つだけなので、決め打ちの名前で同じものを指す */
const CHANNEL_NAME = 'tab'

/** 送り手（拡張 HDAD-tab）からの接続に付ける目印 */
export const SENDER = 'sender'
/** 合成ページからの接続に付ける目印 */
export const VIEWER = 'viewer'

/** 送り手として受け入れてよいかを Worker が伝えるためのクエリ。外には出ない（守りは Worker が済ませている） */
const ROLE_PARAM = 'role'
/** Worker がオーバーレイ用キーを発行し直したときに、合成ページの接続を閉じさせるパス */
const REVOKE_PATH = '/revoke'

/** 眠ったまま応えられる合図と、それに返す合図 */
const PING = 'ping'
const PONG = 'pong'

/** 中継する相手。テストで差し替えられるよう、使うものだけを受け取る */
export type TabSocket = SocketLike

/**
 * Durable Object から使う、接続の保持の仕組み。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * Cloudflare の DurableObjectState はこの形を満たす。
 */
export interface TabChannelState {
  acceptWebSocket(socket: WebSocket, tags?: string[]): void
  getWebSockets(): TabSocket[]
  getTags(socket: TabSocket): string[]
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void
  /** いまのオーバーレイ用キーの目印を覚えておく保管庫 */
  storage: DurableStorage
}

/** 目印の違うキーで開こうとした接続に返す応答。Worker の requireOverlayKey と同じ形にする */
const staleKeyResponse = (): Response =>
  errorResponse(STATUS.unauthorized, 'invalid-overlay-key', 'オーバーレイ用キーが正しくありません。管理画面のURLを貼り直してください')

/**
 * 接続をどちらとして受け入れるか。送り手は配信者のセッションで守られた経路から来たもの、
 * 合成ページはオーバーレイ用キーで守られた経路から来たもので、確かめたキーの目印を添える。
 */
export type TabAccess = { role: 'sender' } | { role: 'viewer'; keyTag: string }

/**
 * Worker が Durable Object を呼ぶための入口。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * Cloudflare の DurableObjectNamespace はこの形を満たす。
 */
export interface TabChannelNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> }
}

/** 送り手と合成ページのあいだで、WebRTC の連絡を両方向に中継する Durable Object */
export class TabChannel {
  /** Cloudflare は (state, env) の2つを渡すが、この Durable Object は保管も外部との通信も行わないので state だけを受け取る */
  constructor(private readonly ctx: TabChannelState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.headers.get('Upgrade') === 'websocket') {
      if (url.searchParams.get(ROLE_PARAM) === SENDER) return this.accept(SENDER)
      // 合成ページはオーバーレイ用キーで開かれるので、覚えている目印と違うキーなら受け入れない（worker/overlay-key.ts）
      if (!(await isCurrentKeyTag(this.ctx.storage, url.searchParams.get(KEY_TAG_PARAM)))) return staleKeyResponse()
      return this.accept(VIEWER)
    }
    if (url.pathname === REVOKE_PATH) return this.revokeViewers(request)
    return new Response(null, { status: STATUS.notFound })
  }

  /**
   * 新しいキーの目印を覚え、合成ページの接続（オーバーレイ用キーで開かれたもの）をすべて閉じる。
   * オーバーレイ用キーを発行し直したときに呼ばれる。送り手（拡張）の接続は配信者のセッションで開かれているので残す。
   */
  private async revokeViewers(request: Request): Promise<Response> {
    // 先に目印を覚えてから閉じる。閉じたあとすぐ古いキーでつなぎ直されても受け入れないため
    if (!(await rememberKeyTag(this.ctx.storage, request))) return new Response(null, { status: STATUS.badRequest })
    closeForRevokedKey(this.ctx.getWebSockets().filter((socket) => this.ctx.getTags(socket).includes(VIEWER)))
    return new Response(null, { status: STATUS.noContent })
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

  /** 接続から届いたものを、反対側の接続（送り手からなら合成ページ、合成ページからなら送り手）へそのまま配る */
  webSocketMessage(socket: TabSocket, message: string | ArrayBuffer): void {
    // 送り手も合成ページも文字列しか送らない。それ以外が届いたら送り主の作りを疑うので、中継しない
    if (typeof message !== 'string') return
    const fromSender = this.ctx.getTags(socket).includes(SENDER)
    const targetRole = fromSender ? VIEWER : SENDER
    broadcast(
      this.ctx.getWebSockets().filter((peer) => peer !== socket && this.ctx.getTags(peer).includes(targetRole)),
      message,
      'タブの映像の連絡',
    )
  }
}

/** 中継先（1つだけ）を指す */
const channelOf = (namespace: TabChannelNamespace): { fetch(request: Request): Promise<Response> } => namespace.get(namespace.idFromName(CHANNEL_NAME))

/**
 * WebSocketの接続を Durable Object へ引き渡す。
 *
 * 送り手として受け入れてよいか（配信者のセッションで守られた経路から来たか）の確認は、呼び出し側
 * （tab-routes.ts・overlay-routes.ts）が済ませている。
 *
 * @param access 送り手か、合成ページ（確かめたキーの目印を添える）か
 */
export const connectTabSocket = (namespace: TabChannelNamespace, request: Request, access: TabAccess): Promise<Response> => {
  const url = new URL(request.url)
  // 利用者の送ってきた役割と目印は捨て、Worker が確かめたものだけを載せる
  url.searchParams.set(ROLE_PARAM, access.role === 'sender' ? SENDER : VIEWER)
  url.searchParams.delete(KEY_TAG_PARAM)
  if (access.role === 'viewer') url.searchParams.set(KEY_TAG_PARAM, access.keyTag)
  return channelOf(namespace).fetch(new Request(url, request))
}

/**
 * オーバーレイ用キーを発行し直したときに、新しいキーの目印を覚えさせ、合成ページの接続を閉じさせる。
 *
 * 注意: 失敗を黙って握りつぶさない。閉じられないと古いキーの接続が残るので、呼び出し側（admin-routes.ts）が失敗を返す。
 *
 * @param keyTag 新しいキーの目印（overlayKeyTag）
 */
export const revokeTabViewers = async (namespace: TabChannelNamespace, keyTag: string): Promise<void> => {
  const response = await channelOf(namespace).fetch(revokeRequest(`https://tab-channel${REVOKE_PATH}`, keyTag))
  if (!response.ok) throw new Error(`タブの映像の接続を切断できませんでした（${response.status}）`)
}
