/**
 * アラートの受け取り（WebSocket）
 *
 * Workerの経路（GET /api/overlay/socket?key=）へつなぐと、Durable Object が接続を保持し、
 * Twitchの通知に当てはまったアラートを押し出してくる。オーバーレイはTwitchへ直接つながない。
 *
 * つなぎ直し・生存確認は素材で共通なので src/core/socket.ts に置き、ここはアラートとしての
 * 読み取り（alert.ts）だけを受け持つ。
 */
import { connectSocket, socketUrl } from '../core/socket'
import { parseAlert, type Alert } from './alert'

const SOCKET_PATH = '/api/overlay/socket'

/** 一度もつながらないまま閉じたときに出す、いちばんありそうな原因 */
const HINT = 'アラートの配送先につながりません。URLのオーバーレイ用キーが正しいか確かめてください'

export interface AlertSocketHandlers {
  /** アラートが届いた */
  onAlert(alert: Alert): void
  /** 切断した（disconnected）・切断後に再びつながった（reconnected） */
  onStatus(status: 'disconnected' | 'reconnected'): void
  /** 待てば直るかもしれない失敗（つなぎ直しは続ける） */
  onWarning(message: string): void
}

/**
 * アラートの配送先へつなぎ、切断されてもつなぎ直し続ける。
 *
 * @param key オーバーレイ用キー（Workerが接続を受け付けるための合言葉）
 */
export const connectAlerts = (key: string, handlers: AlertSocketHandlers): void => {
  connectSocket(
    socketUrl(SOCKET_PATH, { key }),
    {
      onMessage: (text) => {
        try {
          handlers.onAlert(parseAlert(text))
        } catch (error) {
          // 読めない1件のために配信中のアラート全体を止めない。画面に知らせたうえで、原因を追えるよう記録する
          handlers.onWarning(error instanceof Error ? error.message : String(error))
          console.error('届いたアラートを読み取れませんでした', text, error)
        }
      },
      onStatus: (status) => handlers.onStatus(status),
      onWarning: (message) => handlers.onWarning(message),
    },
    HINT,
  )
}
