/**
 * コメントビューアーへの配送（Durable Object）
 *
 * Webhook で届いたチャットの発言や出来事（worker/comment-feed.ts が直した1件）を、コメントビューアー（/comments/）へ
 * その場で届ける。Workerは接続を保持できないので、接続を保持できる Durable Object を1つだけ置き、画面はここへつなぐ。
 *
 * アラートの配送（worker/alert-channel.ts）と分けてあるのは、相手と量が違うためである。アラートの相手は
 * オーバーレイ用キーで守られた合成ページで、届くのはトリガーに当てはまったときだけだが、こちらの相手は配信者の
 * セッションで守られた管理画面で、チャットの発言が1通ごとに届く。
 *
 * 画面を開き直しても直前の流れが見えるよう、直近の1件を上限（RECENT_LIMIT）まで覚えておき、つながった直後に
 * 履歴として渡す。Hibernation で眠るとメモリは消えるので、覚えておく先は Durable Object の保管（storage）である。
 *
 * この Durable Object は中身を読まない（配送者であって判定者ではない）。届いた文字列をそのまま覚えて配り、
 * 形が正しいかは受け取った画面（src/comments/feed.ts）が確かめる。
 *
 * 接続は Hibernation API（ctx.acceptWebSocket）で受ける。つないだままでも待っている間は課金されないため、
 * 配信中ずっとつなぎっぱなしにできる。つないでいる間の合図（ping）には ctx.setWebSocketAutoResponse が
 * この Durable Object を起こさずに応える。
 *
 * 呼ぶのは Worker だけで、次の2つを受け付ける。
 * - Upgrade: websocket のリクエスト: 画面からの接続を受け、直近の履歴を渡す（守りは worker/comment-routes.ts が済ませている）
 * - POST /push: Worker が押し出した1件を覚え、開いている接続すべてへ配る
 *
 * 注意: WebSocketの接続（Upgrade）は Cloudflare のランタイムでしか作れないので、テストでは配る部分と履歴だけを確かめる。
 */
import type { FeedItem } from './comment-feed'
import { STATUS } from './http'
import { broadcast, type SocketLike } from './socket-broadcast'

/** Durable Object の名前。配送先は1つだけなので、決め打ちの名前で同じものを指す */
const CHANNEL_NAME = 'comments'
const PUSH_PATH = '/push'
/** 覚えておく直近の1件を入れる保管の鍵 */
const RECENT_KEY = 'recent'

/**
 * 覚えておく直近の件数。
 *
 * 画面を開き直したときに直前の数分が見えれば足りる。1件はおよそ数百バイトなので、この数でも保管の1行に収まる。
 */
export const RECENT_LIMIT = 200

/** 眠ったまま応えられる合図と、それに返す合図 */
const PING = 'ping'
const PONG = 'pong'

/** 配る相手。テストで差し替えられるよう、使うものだけを受け取る */
export type CommentSocket = SocketLike

/**
 * Durable Object から使う、接続の保持と保管の仕組み。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * Cloudflare の DurableObjectState はこの形を満たす。
 */
export interface CommentChannelState {
  acceptWebSocket(socket: WebSocket): void
  getWebSockets(): CommentSocket[]
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void
  storage: {
    get<T>(key: string): Promise<T | undefined>
    put(key: string, value: unknown): Promise<void>
  }
}

/**
 * Worker が Durable Object を呼ぶための入口。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * Cloudflare の DurableObjectNamespace はこの形を満たす。
 */
export interface CommentChannelNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> }
}

/** Webhook で届いた1件をコメントビューアーへ配る Durable Object */
export class CommentChannel {
  /** Cloudflare は (state, env) の2つを渡すが、この Durable Object は外部との通信を行わないので state だけを受け取る */
  constructor(private readonly ctx: CommentChannelState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') === 'websocket') return this.accept()
    if (new URL(request.url).pathname === PUSH_PATH && request.method === 'POST') return this.push(await request.text())
    return new Response(null, { status: STATUS.notFound })
  }

  /** 画面を開いた直後に渡す、直近の履歴（古い順） */
  async backlog(): Promise<string> {
    const recent = (await this.ctx.storage.get<string[]>(RECENT_KEY)) ?? []
    // 覚えているのは Worker が JSON にした文字列なので、読み直さずにつなげる
    return `{"type":"backlog","items":[${recent.join(',')}]}`
  }

  /** 画面からの接続を受け取り、履歴を渡してから片方を返す。Hibernation API で受けるので、待っている間は課金されない */
  private async accept(): Promise<Response> {
    // つないでいる間の合図（ping）には、この Durable Object を起こさずに応える（起こすと待っている間も課金される）
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG))
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server)
    server.send(await this.backlog())
    return new Response(null, { status: 101, webSocket: client })
  }

  /** 押し出された1件を覚え、開いている接続すべてへ配る */
  private async push(item: string): Promise<Response> {
    const recent = (await this.ctx.storage.get<string[]>(RECENT_KEY)) ?? []
    await this.ctx.storage.put(RECENT_KEY, [...recent, item].slice(-RECENT_LIMIT))
    broadcast(this.ctx.getWebSockets(), `{"type":"item","item":${item}}`, 'コメントビューアーの1件')
    return new Response(null, { status: STATUS.noContent })
  }
}

/** 配送先（1つだけ）を指す */
const channelOf = (namespace: CommentChannelNamespace): { fetch(request: Request): Promise<Response> } =>
  namespace.get(namespace.idFromName(CHANNEL_NAME))

/**
 * 画面からのWebSocketの接続を Durable Object へ引き渡す。
 *
 * 配信者のセッションと送信元の確認は、呼び出し側（comment-routes.ts）が済ませている。
 */
export const connectCommentSocket = (namespace: CommentChannelNamespace, request: Request): Promise<Response> => channelOf(namespace).fetch(request)

/**
 * 1件を Durable Object へ押し出す。
 *
 * 注意: 失敗を黙って握りつぶさない。呼び出し側（webhook-routes.ts）が収集の失敗として記録し、
 * 管理画面から気づけるようにする。
 */
export const pushFeedItem = async (namespace: CommentChannelNamespace, item: FeedItem): Promise<void> => {
  const response = await channelOf(namespace).fetch(
    new Request(`https://comment-channel${PUSH_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) }),
  )
  if (!response.ok) throw new Error(`コメントビューアーの1件を配送先へ送れませんでした（${response.status}）`)
}
