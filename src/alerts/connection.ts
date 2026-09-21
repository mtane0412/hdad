/**
 * EventSubへのWebSocket接続
 *
 * 1. Twitchへ接続すると session_welcome でセッションIDが届く
 * 2. セッションIDをWorkerへ送り、購読の登録を代行してもらう（subscribe.ts。10秒以内に登録しないとTwitchに切断される）
 * 3. 以降の通知はTwitchから直接届く
 *
 * メッセージの解釈は eventsub.ts に任せ、ここは送受信・購読の依頼・つなぎ直しだけを受け持つ。
 *
 * 注意: 切断は配信中に普通に起こるため、間隔を延ばしながらつなぎ直し続ける。
 * 一方、キーの誤りや未ログインなど人が直さないと直らない失敗では、つなぎ直しを止めて onFatal で知らせる。
 */
import { createSeenIds, parseEventSubMessage, type EventSubNotification } from './eventsub'
import { requestSubscriptions } from './subscribe'

const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws'
/** つなぎ直しまでの待ち時間（ミリ秒）。失敗のたびに倍にし、上限で止める */
const RETRY_INITIAL_MS = 1000
const RETRY_MAX_MS = 30000
/** キープアライブの間隔に足す余裕（ミリ秒）。通信の遅れで切断と誤判定しないため */
const KEEPALIVE_MARGIN_MS = 5000
const MILLISECONDS_PER_SECOND = 1000
/** 重複判定のために覚えておくメッセージIDの件数 */
const SEEN_ID_LIMIT = 200

export interface EventSubConnectionHandlers {
  onNotification(notification: EventSubNotification): void
  /** 切断した（disconnected）・切断後に再び通知を受け取れるようになった（reconnected） */
  onStatus(status: 'disconnected' | 'reconnected'): void
  /** 待てば直るかもしれない失敗（つなぎ直しは続ける） */
  onWarning(message: string): void
  /** 人が直さないと直らない失敗（つなぎ直しを止めた） */
  onFatal(message: string): void
}

/**
 * EventSubへ接続し、切断されてもつなぎ直し続ける。
 *
 * @param key オーバーレイ用キー（Workerが購読の依頼を受け付けるための合言葉）
 */
export const connectEventSub = (key: string, handlers: EventSubConnectionHandlers): void => {
  const seen = createSeenIds(SEEN_ID_LIMIT)
  let retryDelay = RETRY_INITIAL_MS
  let disconnected = false
  let stopped = false

  /**
   * @param url 接続先
   * @param predecessor Twitchの要求（session_reconnect）でつなぎ直す場合の、古い接続。購読は引き継がれるので登録し直さない
   */
  const open = (url: string, predecessor?: WebSocket): void => {
    const socket = new WebSocket(url)
    let keepaliveTimer: number | undefined
    /** 役目を終えて自分から閉じる接続。close イベントでつなぎ直さない */
    let retired = false

    const ready = (): void => {
      retryDelay = RETRY_INITIAL_MS
      if (disconnected) handlers.onStatus('reconnected')
      disconnected = false
    }

    const subscribe = async (sessionId: string): Promise<void> => {
      const result = await requestSubscriptions(key, sessionId, (input, init) => fetch(input, init))
      if (result.ok) {
        ready()
        return
      }
      if (result.retryable) {
        handlers.onWarning(result.message)
      } else {
        stopped = true
        handlers.onFatal(result.message)
      }
      socket.close()
    }

    /** Twitchが welcome で知らせてくる「この秒数なにも届かなければ切れている」の値 */
    let keepaliveTimeoutSeconds: number | undefined

    /** メッセージが届くたびに呼ぶ。決まった時間なにも届かなければ接続を閉じる（close イベント経由でつなぎ直す） */
    const watchKeepalive = (): void => {
      if (keepaliveTimeoutSeconds === undefined) return
      window.clearTimeout(keepaliveTimer)
      keepaliveTimer = window.setTimeout(() => socket.close(), keepaliveTimeoutSeconds * MILLISECONDS_PER_SECOND + KEEPALIVE_MARGIN_MS)
    }

    const handleMessage = (text: string): void => {
      const message = parseEventSubMessage(text)
      if (message.type === 'welcome') keepaliveTimeoutSeconds = message.keepaliveTimeoutSeconds
      watchKeepalive()

      switch (message.type) {
        case 'welcome':
          if (predecessor) {
            // 新しい接続が使えるようになったので、古い接続を閉じる
            predecessor.close()
            ready()
          } else {
            void subscribe(message.sessionId)
          }
          break
        case 'notification':
          if (!seen(message.id)) handlers.onNotification(message)
          break
        case 'reconnect':
          retired = true
          open(message.url, socket)
          break
        case 'revocation':
          stopped = true
          handlers.onFatal(`Twitchが ${message.subscriptionType} の購読を取り消しました（${message.status}）。ログインし直してください`)
          socket.close()
          break
        case 'keepalive':
          break
      }
    }

    socket.addEventListener('message', ({ data }) => {
      try {
        handleMessage(String(data))
      } catch (error) {
        // 読めない1通のために配信中のアラート全体を止めない。画面に知らせたうえで、原因を追えるよう記録する
        handlers.onWarning(error instanceof Error ? error.message : String(error))
        console.error('EventSubのメッセージを処理できませんでした', data, error)
      }
    })

    socket.addEventListener('close', () => {
      window.clearTimeout(keepaliveTimer)
      if (retired || stopped) return
      if (!disconnected) handlers.onStatus('disconnected')
      disconnected = true
      window.setTimeout(() => open(EVENTSUB_URL), retryDelay)
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
    })
  }

  open(EVENTSUB_URL)
}
