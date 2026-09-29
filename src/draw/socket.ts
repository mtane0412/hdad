/**
 * 手書きの線のやりとり（WebSocket）
 *
 * 描く画面（/draw/）と合成ページ（overlay/stage/index.html）は、どちらもWorkerの経路を通して
 * 同じ中継先（worker/draw-channel.ts の Durable Object）へつなぐ。描く画面は送る側、合成ページは受け取る側で、
 * どちらとして扱うかはつなぐ経路が決める（合成ページが使うオーバーレイ用キーだけでは描けない）。
 *
 * つなぎ直し・生存確認は src/core/socket.ts が受け持ち、ここは経路と読み取り（stroke.ts）だけを足す。
 */
import { connectSocket, socketUrl, type SocketConnection } from '../core/socket'
import { parseDrawMessage, type DrawMessage } from './stroke'

/** 描く画面がつなぐ経路（配信者のセッションで守られている） */
const WRITER_PATH = '/api/admin/draw/socket'
/** 合成ページがつなぐ経路（オーバーレイ用キーで守られている） */
const VIEWER_PATH = '/api/overlay/draw'

const WRITER_HINT = '手書きの中継先につながりません。ログインが切れていないか確かめてください'
const VIEWER_HINT = '手書きの中継先につながりません。URLのオーバーレイ用キーが正しいか確かめてください'

export interface DrawSocketHandlers {
  /** 切断した（disconnected）・切断後に再びつながった（reconnected） */
  onStatus(status: 'disconnected' | 'reconnected'): void
  /** 待てば直るかもしれない失敗（つなぎ直しは続ける） */
  onWarning(message: string): void
}

export interface DrawViewerHandlers extends DrawSocketHandlers {
  /** 線が届いた */
  onMessage(message: DrawMessage): void
}

/**
 * 合成ページとして中継先へつなぎ、届いた線を受け取る。
 *
 * @param key オーバーレイ用キー（Workerが接続を受け付けるための合言葉）
 */
export const connectDrawViewer = (key: string, handlers: DrawViewerHandlers): void => {
  connectSocket(
    socketUrl(VIEWER_PATH, { key }),
    {
      onMessage: (text) => {
        try {
          handlers.onMessage(parseDrawMessage(text))
        } catch (error) {
          // 読めない1通のために配信中の手書き全体を止めない。画面に知らせたうえで、原因を追えるよう記録する
          handlers.onWarning(error instanceof Error ? error.message : String(error))
          console.error('届いた手書きの線を読み取れませんでした', text, error)
        }
      },
      onStatus: (status) => handlers.onStatus(status),
      onWarning: (message) => handlers.onWarning(message),
    },
    VIEWER_HINT,
  )
}

/** 描く画面から中継先へ線を送るための窓口 */
export interface DrawWriter {
  /**
   * 線を1通送る。
   *
   * @returns 送れたなら true。つながっていなければ false（描いている途中で切れた分は貯めずに落とす）
   */
  send(message: DrawMessage): boolean
  /** つなぐのをやめる。描く画面を離れるときに呼ぶ（呼ばないと画面を行き来するたびに接続が増える） */
  close(): void
}

/** 描く画面として中継先へつなぎ、線を送れるようにする */
export const connectDrawWriter = (handlers: DrawSocketHandlers): DrawWriter => {
  const connection: SocketConnection = connectSocket(
    socketUrl(WRITER_PATH),
    {
      // 中継先は送り主へ返さないので、描く画面に届くものはない
      onMessage: () => undefined,
      onStatus: (status) => handlers.onStatus(status),
      onWarning: (message) => handlers.onWarning(message),
    },
    WRITER_HINT,
  )
  return { send: (message) => connection.send(JSON.stringify(message)), close: () => connection.close() }
}
