/**
 * WebSocketの接続の続け方（素材が共通で使う）
 *
 * オーバーレイや描く画面は、Workerの経路を通して Durable Object へつなぎ、そこから押し出されるものを受け取る。
 * 切断は配信中に普通に起こるため、間隔を延ばしながらつなぎ直し続ける。
 *
 * 届いた文字列の読み取りは呼び出し側に任せ、ここは接続・つなぎ直し・生存確認だけを受け持つ。
 *
 * 注意: 一度もつながらないまま閉じた場合（キーの誤り・未ログインでWorkerが401を返した場合を含む）も、
 * ブラウザのWebSocketからは状態コードを読めないため、原因の手がかりを呼び出し側へ渡したうえで
 * つなぎ直しは続ける。
 */

/** つなぎ直しまでの待ち時間（ミリ秒）。失敗のたびに倍にし、上限で止める */
const RETRY_INITIAL_MS = 1000
const RETRY_MAX_MS = 30000

/**
 * 生存確認を送る間隔（ミリ秒）。
 *
 * 途中の経路が黙っている接続を切ることがあるため、こちらから定期的に合図を送る。
 * つなぎ先（Durable Object）は眠ったままこれに応えるので、この合図で課金は増えない。
 */
const PING_INTERVAL_MS = 30000
/** つなぎ先が眠ったまま応えられる合図と、その返事。worker/alert-channel.ts・worker/draw-channel.ts と合わせる */
const PING = 'ping'
const PONG = 'pong'

/**
 * つなぎ先。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * ブラウザの WebSocket はこの形を満たす。
 */
export interface SocketLike {
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  send(data: string): void
}

export interface SocketHandlers {
  /** 生存確認の返事でない文字列が届いた */
  onMessage(text: string): void
  /** 切断した（disconnected）・切断後に再びつながった（reconnected） */
  onStatus(status: 'disconnected' | 'reconnected'): void
  /** 待てば直るかもしれない失敗（つなぎ直しは続ける） */
  onWarning(message: string): void
}

/** つなぎ続けている接続への窓口 */
export interface SocketConnection {
  /**
   * つながっていれば送る。
   *
   * @returns 送れたなら true。つながっていなければ送らずに false（貯めて後から流すと、時間のずれたものが現れる）
   */
  send(text: string): boolean
}

/** 同じサイトのWorkerへ、httpではなくwsのURLでつなぐ */
export const socketUrl = (path: string, query: Record<string, string> = {}): string => {
  const url = new URL(path, location.origin)
  for (const [名前, 値] of Object.entries(query)) url.searchParams.set(名前, 値)
  return url.toString().replace(/^http/, 'ws')
}

/**
 * つなぎ先へつなぎ、切断されてもつなぎ直し続ける。
 *
 * @param url つなぎ先（socketUrl で作る）
 * @param hint 一度もつながらないまま閉じたときに、呼び出し側へ渡す手がかりの文
 * @param open つなぎ方。テストで差し替えるためだけに受け取る
 */
export const connectSocket = (
  url: string,
  handlers: SocketHandlers,
  hint: string,
  open: (url: string) => SocketLike = (つなぎ先) => new WebSocket(つなぎ先),
): SocketConnection => {
  let retryDelay = RETRY_INITIAL_MS
  let disconnected = false
  /** いまつながっている接続。つながっていなければ null（送る先がない） */
  let 使える接続: SocketLike | null = null

  const つなぐ = (): void => {
    const socket = open(url)
    let pingTimer: number | undefined
    /** この接続が一度でもつながったか。つながらないまま閉じたなら、キーや設定を疑う手がかりを出す */
    let opened = false

    socket.onopen = () => {
      opened = true
      使える接続 = socket
      retryDelay = RETRY_INITIAL_MS
      if (disconnected) handlers.onStatus('reconnected')
      disconnected = false
      pingTimer = window.setInterval(() => socket.send(PING), PING_INTERVAL_MS)
    }

    socket.onmessage = ({ data }) => {
      const text = String(data)
      // 生存確認の返事は中身ではない
      if (text === '' || text === PING || text === PONG) return
      handlers.onMessage(text)
    }

    socket.onclose = () => {
      window.clearInterval(pingTimer)
      使える接続 = null
      // ブラウザのWebSocketは、つながらなかった理由（Workerの401など）を教えてくれない。
      // 一度もつながっていないなら、いちばんありそうな原因を添えて知らせる
      if (!opened) handlers.onWarning(hint)
      else if (!disconnected) handlers.onStatus('disconnected')
      disconnected = true
      window.setTimeout(つなぐ, retryDelay)
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
    }
  }

  つなぐ()

  return {
    send: (text) => {
      if (使える接続 === null) return false
      使える接続.send(text)
      return true
    },
  }
}
