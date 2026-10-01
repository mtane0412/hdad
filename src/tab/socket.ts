/**
 * タブの映像の連絡のやりとり（WebSocket）
 *
 * 送り手（拡張の offscreen document）と合成ページ（素材 `tab`）は、どちらもWorkerの経路を通して同じ中継先
 * （worker/tab-channel.ts の Durable Object）へつなぐ。送り手として扱うか合成ページとして扱うかは、つなぐ経路が決める。
 *
 * つなぎ直し・生存確認は src/core/socket.ts が受け持ち、ここは経路と連絡の読み書き（signal.ts）だけを足す。
 */
import { connectSocket, socketUrl } from '../core/socket'
import { SENDER_PROTOCOL, parseFromSender, parseFromViewer, type FromSender, type FromViewer } from './signal'

/** 送り手がつなぐ経路（配信者のセッションで守られている） */
const SENDER_PATH = '/api/admin/tab/socket'
/** 合成ページがつなぐ経路（オーバーレイ用キーで守られている） */
const VIEWER_PATH = '/api/overlay/tab'

const SENDER_HINT = 'タブの映像の中継先につながりません。Chrome で HDAD にログインしているか確かめてください'
const VIEWER_HINT = 'タブの映像の中継先につながりません。URLのオーバーレイ用キーが正しいか確かめてください'

export interface TabSocketHandlers<M> {
  /** 連絡が届いた */
  onMessage(message: M): void
  /** つながった（つなぎ直しも含む）。名乗る・名乗り直しを頼むきっかけにする */
  onOpen(): void
  /** 切断した（disconnected）・切断後に再びつながった（reconnected） */
  onStatus(status: 'disconnected' | 'reconnected'): void
  /** 待てば直るかもしれない失敗（つなぎ直しは続ける） */
  onWarning(message: string): void
}

/** 連絡を送るための窓口 */
export interface TabSocket<M> {
  /**
   * 連絡を1通送る。
   *
   * @returns 送れたなら true。つながっていなければ false（貯めずに落とす。つながったときに名乗り直すので取り戻せる）
   */
  send(message: M): boolean
  /** つなぐのをやめる。画面を離れるときに呼ぶ */
  close(): void
}

/**
 * 経路へつなぎ、届いた文字列を読んで渡す。
 *
 * @param protocols つなぐ（つなぎ直す）たびに読む WebSocket のプロトコル（送り手だけが使う。SENDER_PROTOCOL を参照）
 */
const connect = <In, Out>(
  url: string,
  parse: (text: string) => In,
  handlers: TabSocketHandlers<In>,
  hint: string,
  protocols: () => readonly string[] = () => [],
): TabSocket<Out> => {
  const connection = connectSocket(
    url,
    {
      onMessage: (text) => {
        try {
          handlers.onMessage(parse(text))
        } catch (error) {
          // 読めない1通のために映像全体を止めない。画面に知らせたうえで、原因を追えるよう記録する
          handlers.onWarning(error instanceof Error ? error.message : String(error))
          console.error('届いたタブの映像の連絡を読み取れませんでした', text, error)
        }
      },
      onOpen: () => handlers.onOpen(),
      onStatus: (status) => handlers.onStatus(status),
      onWarning: (message) => handlers.onWarning(message),
    },
    hint,
    (target) => new WebSocket(target, [...protocols()]),
  )
  return { send: (message) => connection.send(JSON.stringify(message)), close: () => connection.close() }
}

/**
 * 合成ページとして中継先へつなぐ。
 *
 * @param key オーバーレイ用キー（Workerが接続を受け付けるための合言葉）
 */
export const connectTabViewer = (key: string, handlers: TabSocketHandlers<FromSender>): TabSocket<FromViewer> =>
  connect(socketUrl(VIEWER_PATH, { key }), parseFromSender, handlers, VIEWER_HINT)

/**
 * 送り手として中継先へつなぐ。
 *
 * @param origin HDAD の置き場所（送り手は拡張の画面なので、開いている場所と HDAD が違う）
 * @param session 配信者のセッション（拡張が chrome.cookies で読んだ値）を返す関数。クッキーが付かないので、プロトコルの欄で渡す。
 *   つなぎ直すたびに呼ぶので、映し始めるたびに読み直した新しい値が次のつなぎ直しから使われる（古い値で断られ続けない）
 */
export const connectTabSender = (origin: string, session: () => string, handlers: TabSocketHandlers<FromViewer>): TabSocket<FromSender> =>
  connect(socketUrl(SENDER_PATH, {}, origin), parseFromViewer, handlers, SENDER_HINT, () => [SENDER_PROTOCOL, session()])
