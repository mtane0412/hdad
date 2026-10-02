/**
 * 字幕のやりとり（WebSocket）
 *
 * アプリの枠（送る側）と合成ページ（受け取る側）は、どちらもWorkerの経路を通して同じ字幕の中継先
 * （worker/draw-channel.ts の DrawChannel を caption の名前で使う）へつなぐ。どちらとして扱うかはつなぐ経路が決める
 * （合成ページが使うオーバーレイ用キーだけでは字幕を出せない）。
 *
 * つなぎ直し・生存確認は src/core/socket.ts が受け持ち、ここは経路と読み取り（message.ts）だけを追加する。
 */
import { connectSocket, socketUrl } from '../core/socket'
import { parseCaptionMessage, type CaptionMessage } from './message'

/** アプリの枠がつなぐ経路（配信者のセッションで守られている） */
const WRITER_PATH = '/api/admin/caption/socket'
/** 合成ページがつなぐ経路（オーバーレイ用キーで守られている） */
const VIEWER_PATH = '/api/overlay/caption'

const WRITER_HINT = '字幕の中継先につながりません。ログインが切れていないか確かめてください'
const VIEWER_HINT = '字幕の中継先につながりません。URLのオーバーレイ用キーが正しいか確かめてください'

export interface CaptionSocketHandlers {
  /** 切断した（disconnected）・切断後に再びつながった（reconnected） */
  onStatus(status: 'disconnected' | 'reconnected'): void
  /** 待てば直るかもしれない失敗（つなぎ直しは続ける） */
  onWarning(message: string): void
}

export interface CaptionViewerHandlers extends CaptionSocketHandlers {
  /** 字幕が届いた */
  onMessage(message: CaptionMessage): void
}

/**
 * 合成ページとして字幕の中継先へつなぎ、届いた字幕を受け取る。
 *
 * @param key オーバーレイ用キー（Workerが接続を受け付けるための合言葉）
 */
export const connectCaptionViewer = (key: string, handlers: CaptionViewerHandlers): void => {
  connectSocket(
    socketUrl(VIEWER_PATH, { key }),
    {
      onMessage: (text) => {
        try {
          handlers.onMessage(parseCaptionMessage(text))
        } catch (error) {
          // 読めない1通のために配信中の字幕全体を止めない。画面に知らせたうえで、原因を追えるよう記録する
          handlers.onWarning(error instanceof Error ? error.message : String(error))
          console.error('届いた字幕を読み取れませんでした', text, error)
        }
      },
      onStatus: (status) => handlers.onStatus(status),
      onWarning: (message) => handlers.onWarning(message),
    },
    VIEWER_HINT,
  )
}

/** アプリの枠から字幕の中継先へ送るための窓口 */
export interface CaptionWriter {
  /**
   * 1通送る。
   *
   * @returns 送れたなら true。つながっていなければ false（字幕は流れていくものなので貯めずに落とす）
   */
  send(message: CaptionMessage): boolean
  /** つなぐのをやめる。認識を止めるときに呼ぶ */
  close(): void
}

/** アプリの枠として字幕の中継先へつなぎ、字幕を送れるようにする */
export const connectCaptionWriter = (handlers: CaptionSocketHandlers): CaptionWriter => {
  const connection = connectSocket(
    socketUrl(WRITER_PATH),
    {
      // 中継先は送り主へ返さないので、アプリの枠に届くものはない
      onMessage: () => undefined,
      onStatus: (status) => handlers.onStatus(status),
      onWarning: (message) => handlers.onWarning(message),
    },
    WRITER_HINT,
  )
  return { send: (message) => connection.send(JSON.stringify(message)), close: () => connection.close() }
}
