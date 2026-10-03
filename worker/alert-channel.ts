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
 * BGMの切り替え（「いま流している曲」）も、この Durable Object が裏方のページ（overlay/backstage/ の ?bgm=true）へ配る
 * （issue #151）。専用の Durable Object を追加しないのは、新しい Durable Object を追加すると PR ブランチの
 * プレビュービルドが失敗するためである。受け取る側の読み取りが違う（合成ページはアラートとしてしか読めない）ので、
 * 接続を受け入れるときに目印（タグ）を付け、アラートはアラートの接続へ、BGMはBGMの接続へだけ配る。
 * どちらの目印で受け入れるかは Worker が決める（手書きの中継 worker/draw-channel.ts と同じ分け方）。
 *
 * 注意: WebSocketの接続（Upgrade）は Cloudflare のランタイムでしか作れないので、テストでは配送の部分だけを確かめる。
 */
import type { OverlayAlert } from './alert-event'
import type { BgmNowPlaying } from './bgm-config'
import { STATUS, errorResponse } from './http'
import { KEY_TAG_PARAM, isCurrentKeyTag, rememberKeyTag, revokeRequest, type DurableStorage } from './overlay-key'
import { broadcast, closeForRevokedKey, type SocketLike } from './socket-broadcast'

/** Durable Object の名前。配送先は1つだけなので、決め打ちの名前で同じものを指す */
const CHANNEL_NAME = 'alerts'

/** Worker がアラートの押し出しに使うパス。外には出ない（オーバーレイ用キーの確認はWorkerが済ませている） */
const PUSH_PATH = '/push'
/** Worker がBGMの切り替えの押し出しに使うパス */
const PUSH_BGM_PATH = '/push/bgm'
/** Worker がオーバーレイ用キーを発行し直したときに、開いている接続を閉じさせるパス */
const REVOKE_PATH = '/revoke'

/** アラートを受け取る接続（合成ページ）に付ける目印 */
const ALERTS_TOPIC = 'alerts'
/** BGMの切り替えを受け取る接続（裏方のページ）に付ける目印 */
const BGM_TOPIC = 'bgm'
/** どちらの目印で受け入れるかを Worker が伝えるためのクエリ。外には出ない */
const TOPIC_PARAM = 'topic'

/** オーバーレイが送ってくる合図と、それに返す合図。Durable Object を起こさずに応えるために使う */
const PING = 'ping'
const PONG = 'pong'

/** アラートの送り先。実体は配送の共通部分（socket-broadcast.ts）の接続と同じ */
export type AlertSocket = SocketLike

/**
 * Durable Object から使う、接続の保持の仕組み。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * Cloudflare の DurableObjectState はこの形を満たす。
 */
export interface AlertChannelState {
  acceptWebSocket(socket: WebSocket, tags?: string[]): void
  getWebSockets(tag?: string): AlertSocket[]
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void
  /** いまのオーバーレイ用キーの目印を覚えておく保管庫 */
  storage: DurableStorage
}

/** 目印の違うキーで開こうとした接続に返す応答。Worker の requireOverlayKey と同じ形にする */
const staleKeyResponse = (): Response =>
  errorResponse(STATUS.unauthorized, 'invalid-overlay-key', 'オーバーレイ用キーが正しくありません。管理画面のURLを貼り直してください')

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
 * アラートを配るだけの Durable Object。
 *
 * 呼ぶのは Worker だけで、次の2つを受け付ける。
 * - Upgrade: websocket のリクエスト: オーバーレイからの接続を受ける（パスはWorkerのものがそのまま届く）。
 *   クエリの topic が bgm ならBGMの接続、それ以外はアラートの接続として受け入れる
 * - POST /push: Worker が押し出したアラートを、アラートの接続すべてへ配る
 * - POST /push/bgm: Worker が押し出した「いま流している曲」を、BGMの接続すべてへ配る
 * - POST /revoke: 新しいキーの目印を覚え、接続をすべて閉じる（オーバーレイ用キーを発行し直したとき。どの接続もオーバーレイ用キーで開かれている）
 *
 * 接続はどれもオーバーレイ用キーで開かれるので、覚えている目印と違うキーの接続は受け入れない（worker/overlay-key.ts）。
 */
export class AlertChannel {
  /** Cloudflare は (state, env) の2つを渡すが、この Durable Object は保管も外部との通信も行わないので state だけを受け取る */
  constructor(private readonly ctx: AlertChannelState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.headers.get('Upgrade') === 'websocket') {
      if (!(await isCurrentKeyTag(this.ctx.storage, url.searchParams.get(KEY_TAG_PARAM)))) return staleKeyResponse()
      return this.accept(url.searchParams.get(TOPIC_PARAM) === BGM_TOPIC ? BGM_TOPIC : ALERTS_TOPIC)
    }
    if (url.pathname === PUSH_PATH) return this.push(ALERTS_TOPIC, await request.text(), 'アラート')
    if (url.pathname === PUSH_BGM_PATH) return this.push(BGM_TOPIC, await request.text(), 'BGMの切り替え')
    if (url.pathname === REVOKE_PATH) {
      // 先に目印を覚えてから閉じる。閉じたあとすぐ古いキーでつなぎ直されても受け入れないため
      if (!(await rememberKeyTag(this.ctx.storage, request))) return new Response(null, { status: STATUS.badRequest })
      closeForRevokedKey(this.ctx.getWebSockets())
      return new Response(null, { status: STATUS.noContent })
    }
    return new Response(null, { status: STATUS.notFound })
  }

  /** オーバーレイからの接続を受け取り、片方を返す。Hibernation API で受けるので、待っている間は課金されない */
  private accept(topic: string): Response {
    // つないでいる間の合図（ping）には、この Durable Object を起こさずに応える（起こすと待っている間も課金される）
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG))
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server, [topic])
    return new Response(null, { status: 101, webSocket: client })
  }

  /** 押し出されたものを、その目印の接続すべてへ配る */
  private push(topic: string, payload: string, subject: string): Response {
    broadcast(this.ctx.getWebSockets(topic), payload, subject)
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
 *
 * @param keyTag 確かめたキーの目印（overlayKeyTag）
 */
export const connectAlertSocket = (namespace: AlertChannelNamespace, request: Request, keyTag: string): Promise<Response> =>
  connectWithTopic(namespace, request, ALERTS_TOPIC, keyTag)

/**
 * 裏方のページからのWebSocketの接続を、BGMの切り替えを受け取る接続として Durable Object へ引き渡す。
 *
 * オーバーレイ用キーの確認は呼び出し側（bgm-routes.ts）が済ませている。
 *
 * @param keyTag 確かめたキーの目印（overlayKeyTag）
 */
export const connectBgmSocket = (namespace: AlertChannelNamespace, request: Request, keyTag: string): Promise<Response> =>
  connectWithTopic(namespace, request, BGM_TOPIC, keyTag)

/** 受け取る側の目印とキーの目印をクエリに載せて接続を引き渡す。利用者の送ってきた値は上書きする */
const connectWithTopic = (namespace: AlertChannelNamespace, request: Request, topic: string, keyTag: string): Promise<Response> => {
  const url = new URL(request.url)
  url.searchParams.set(TOPIC_PARAM, topic)
  url.searchParams.set(KEY_TAG_PARAM, keyTag)
  return channelOf(namespace).fetch(new Request(url, request))
}

/** Durable Object へ JSON を押し出す。失敗を返されたら投げる */
const pushJson = async (namespace: AlertChannelNamespace, path: string, body: unknown, subject: string): Promise<void> => {
  const response = await channelOf(namespace).fetch(
    new Request(`https://alert-channel${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  )
  if (!response.ok) throw new Error(`${subject}を配送先へ送れませんでした（${response.status}）`)
}

/**
 * 当てはまったアラートを Durable Object へ押し出す。
 *
 * 注意: 失敗を黙って握りつぶさない。呼び出し側（webhook-routes.ts）が収集の失敗として記録し、
 * 管理画面から気づけるようにする。
 */
export const pushAlert = (namespace: AlertChannelNamespace, alert: OverlayAlert): Promise<void> => pushJson(namespace, PUSH_PATH, alert, 'アラート')

/**
 * 「いま流している曲」を Durable Object へ押し出す。管理画面で流す曲や音量を変えたときに呼ぶ。
 *
 * 注意: 失敗を黙って握りつぶさない。呼び出し側（bgm-routes.ts）が管理画面へ失敗を返す。
 */
export const pushBgm = (namespace: AlertChannelNamespace, nowPlaying: BgmNowPlaying): Promise<void> =>
  pushJson(namespace, PUSH_BGM_PATH, nowPlaying, 'BGMの切り替え')

/**
 * オーバーレイ用キーを発行し直したときに、新しいキーの目印を覚えさせ、開いている接続（アラート・BGM）をすべて閉じさせる。
 *
 * 注意: 失敗を黙って握りつぶさない。閉じられないと古いキーの接続が残るので、呼び出し側（admin-routes.ts）が失敗を返す。
 *
 * @param keyTag 新しいキーの目印（overlayKeyTag）
 */
export const revokeAlertSockets = async (namespace: AlertChannelNamespace, keyTag: string): Promise<void> => {
  const response = await channelOf(namespace).fetch(revokeRequest(`https://alert-channel${REVOKE_PATH}`, keyTag))
  if (!response.ok) throw new Error(`アラート・BGMの接続を切断できませんでした（${response.status}）`)
}
