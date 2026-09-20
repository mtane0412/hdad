/**
 * TwitchチャットへのWebSocket接続
 *
 * 匿名ユーザー（justinfan＋数字。パスワード不要・読み取り専用）としてIRCへ接続する。
 * 認証が要らないため、静的なページ（GitHub Pages）とURLだけで動作する。
 * 行の解釈は event.ts に任せ、ここは送受信と再接続だけを受け持つ。
 *
 * 注意: 配信中に回線やTwitch側の都合で切断されることは普通に起こるため、切断は失敗として止めず、
 * 間隔を延ばしながら再接続し続ける。切断・復帰は onStatus で呼び出し元へ知らせる（画面に表示する）。
 */
import { toChatEvent, type ChatEvent } from './event'
import { parseIrcLine } from './irc'

const TWITCH_IRC_URL = 'wss://irc-ws.chat.twitch.tv:443'
/** 再接続までの待ち時間（ミリ秒）。失敗のたびに倍にし、上限で止める */
const RETRY_INITIAL_MS = 1000
const RETRY_MAX_MS = 30000
/** 匿名ユーザー名に付ける数字の範囲 */
const ANONYMOUS_NUMBER_RANGE = 100000

/** 接続の利用者が受け取る通知 */
export interface ChatConnectionHandlers {
  /** 表示に関わるイベント（ping と reconnect は接続側で処理するので届かない） */
  onEvent(event: Exclude<ChatEvent, { type: 'ping' | 'reconnect' }>): void
  /** 切断した（disconnected）・切断後に再びつながった（reconnected） */
  onStatus(status: 'disconnected' | 'reconnected'): void
}

/**
 * チャンネルのチャットへ接続し、切断されても再接続し続ける。
 *
 * @param channel チャンネル名（小文字）
 */
export const connectChat = (channel: string, handlers: ChatConnectionHandlers): void => {
  let retryDelay = RETRY_INITIAL_MS
  let disconnected = false

  const open = (): void => {
    const socket = new WebSocket(TWITCH_IRC_URL)

    const handleLine = (line: string): void => {
      const event = toChatEvent(parseIrcLine(line))
      if (!event) return
      if (event.type === 'ping') socket.send(`PONG :${event.payload}`)
      // Twitchからの再接続要求。閉じれば close イベント経由でつなぎ直す
      else if (event.type === 'reconnect') socket.close()
      else handlers.onEvent(event)
    }

    socket.addEventListener('open', () => {
      // tags: 名前色・エモート位置などのタグ、commands: CLEARCHAT などTwitch独自のコマンドを受け取る
      socket.send('CAP REQ :twitch.tv/tags twitch.tv/commands')
      socket.send(`NICK justinfan${Math.floor(Math.random() * ANONYMOUS_NUMBER_RANGE)}`)
      socket.send(`JOIN #${channel}`)
      retryDelay = RETRY_INITIAL_MS
      if (disconnected) handlers.onStatus('reconnected')
      disconnected = false
    })

    socket.addEventListener('message', ({ data }) => {
      for (const line of String(data).split('\r\n')) {
        if (line === '') continue
        try {
          handleLine(line)
        } catch (error) {
          // 読めない1行のために配信中のチャット欄全体を止めない。その行だけ捨てて、原因を追えるよう記録する
          console.error('チャットの行を処理できませんでした', line, error)
        }
      }
    })

    socket.addEventListener('close', () => {
      if (!disconnected) handlers.onStatus('disconnected')
      disconnected = true
      window.setTimeout(open, retryDelay)
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
    })
  }

  open()
}
