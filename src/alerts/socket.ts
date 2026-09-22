/**
 * アラートの受け取り（WebSocket）
 *
 * Workerの経路（GET /api/overlay/socket?key=）へつなぐと、Durable Object が接続を保持し、
 * Twitchの通知に当てはまったアラートを押し出してくる。オーバーレイはTwitchへ直接つながない。
 *
 * メッセージの読み取りは alert.ts に任せ、ここは接続・つなぎ直し・生存確認だけを受け持つ。
 *
 * 注意: 切断は配信中に普通に起こるため、間隔を延ばしながらつなぎ直し続ける。
 * 一度もつながらないまま閉じた場合（キーの誤り・未ログインでWorkerが401を返した場合を含む）も、
 * ブラウザのWebSocketからは状態コードを読めないため、原因の手がかりを画面に出したうえでつなぎ直しは続ける。
 */
import { parseAlert, type Alert } from './alert'

const SOCKET_PATH = '/api/overlay/socket'

/** つなぎ直しまでの待ち時間（ミリ秒）。失敗のたびに倍にし、上限で止める */
const RETRY_INITIAL_MS = 1000
const RETRY_MAX_MS = 30000

/**
 * 生存確認を送る間隔（ミリ秒）。
 *
 * 途中の経路が黙っている接続を切ることがあるため、こちらから定期的に合図を送る。
 * 配送先（Durable Object）は眠ったままこれに応えるので、この合図で課金は増えない。
 */
const PING_INTERVAL_MS = 30000
/** 配送先が眠ったまま応えられる合図。worker/alert-channel.ts の PING と合わせる */
const PING = 'ping'

export interface AlertSocketHandlers {
  /** アラートが届いた */
  onAlert(alert: Alert): void
  /** 切断した（disconnected）・切断後に再びつながった（reconnected） */
  onStatus(status: 'disconnected' | 'reconnected'): void
  /** 待てば直るかもしれない失敗（つなぎ直しは続ける） */
  onWarning(message: string): void
}

/** 同じサイトのWorkerへ、httpではなくwsのURLでつなぐ */
const socketUrl = (key: string): string => `${location.origin.replace(/^http/, 'ws')}${SOCKET_PATH}?key=${encodeURIComponent(key)}`

/**
 * アラートの配送先へつなぎ、切断されてもつなぎ直し続ける。
 *
 * @param key オーバーレイ用キー（Workerが接続を受け付けるための合言葉）
 */
export const connectAlerts = (key: string, handlers: AlertSocketHandlers): void => {
  let retryDelay = RETRY_INITIAL_MS
  let disconnected = false

  const open = (): void => {
    const socket = new WebSocket(socketUrl(key))
    let pingTimer: number | undefined
    /** この接続が一度でもつながったか。つながらないまま閉じたなら、キーや設定を疑う手がかりを出す */
    let opened = false

    socket.addEventListener('open', () => {
      opened = true
      retryDelay = RETRY_INITIAL_MS
      if (disconnected) handlers.onStatus('reconnected')
      disconnected = false
      pingTimer = window.setInterval(() => socket.send(PING), PING_INTERVAL_MS)
    })

    socket.addEventListener('message', ({ data }) => {
      const text = String(data)
      // 生存確認の返事はアラートではない
      if (text === '' || text === PING || text === 'pong') return
      try {
        handlers.onAlert(parseAlert(text))
      } catch (error) {
        // 読めない1件のために配信中のアラート全体を止めない。画面に知らせたうえで、原因を追えるよう記録する
        handlers.onWarning(error instanceof Error ? error.message : String(error))
        console.error('届いたアラートを読み取れませんでした', data, error)
      }
    })

    socket.addEventListener('close', () => {
      window.clearInterval(pingTimer)
      // ブラウザのWebSocketは、つながらなかった理由（Workerの401など）を教えてくれない。
      // 一度もつながっていないなら、いちばんありそうな原因を添えて知らせる
      if (!opened) handlers.onWarning('アラートの配送先につながりません。URLのオーバーレイ用キーが正しいか確かめてください')
      else if (!disconnected) handlers.onStatus('disconnected')
      disconnected = true
      window.setTimeout(open, retryDelay)
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
    })
  }

  open()
}
