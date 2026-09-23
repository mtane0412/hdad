/**
 * ゆかコネNEO のWebSocketサーバーへの接続
 *
 * ゆかコネNEO は動かしているPCの上に WebSocket サーバーを立てる（既定のポートは 11901。実際のポートは
 * レジストリ HKCU\Software\YukarinetteConnectorNeo\WebSocket にあるが、ブラウザからは読めないので
 * URLパラメータで受け取る）。このページは OBS のブラウザソースとして同じPCの上で開かれる前提で、
 * その localhost へつなぐ。
 *
 * 届いたデータの読み取りは message.ts に任せ、ここは接続・つなぎ直しだけを受け持つ
 * （src/alerts/socket.ts と同じ分け方）。
 *
 * 注意: このページ自体は https で配信されるため、ws:// への接続は混在コンテンツにあたる。ブラウザは
 * localhost を安全な接続元として例外扱いするので通る見込みだが、OBS内蔵のCEFのバージョン次第である。
 * 通らない場合は接続が開かないまま閉じるので、その手がかりを画面に出す（onWarning）。
 */

/** つなぎ直しまでの待ち時間（ミリ秒）。失敗のたびに倍にし、上限で止める */
const RETRY_INITIAL_MS = 1000
const RETRY_MAX_MS = 30000

export interface TranscriptSocketHandlers {
  /** 1件届いた（読み取りは呼び出し側が行う） */
  onData(data: string): void
  /** つながった（connected）・切れた（disconnected） */
  onStatus(status: 'connected' | 'disconnected'): void
  /** 待てば直るかもしれない失敗（つなぎ直しは続ける） */
  onWarning(message: string): void
}

/** ゆかコネNEO の、認識結果を細かく載せるエンドポイント。本文だけの /textonly には MsgID も isDeleted も無い */
const ENDPOINT = '/'

/** 接続先のURLを組み立てる */
export const transcriptSocketUrl = (host: string, port: number): string => `ws://${host}:${port}${ENDPOINT}`

/**
 * ゆかコネNEO へつなぎ、切断されてもつなぎ直し続ける。
 *
 * @param host つなぎ先のホスト名（既定は localhost）
 * @param port ゆかコネNEO の WebSocket のポート番号
 */
export const connectTranscript = (host: string, port: number, handlers: TranscriptSocketHandlers): void => {
  const url = transcriptSocketUrl(host, port)
  let retryDelay = RETRY_INITIAL_MS

  const open = (): void => {
    const socket = new WebSocket(url)
    /** この接続が一度でもつながったか。つながらないまま閉じたなら、ゆかコネNEO側や混在コンテンツを疑う手がかりを出す */
    let opened = false

    socket.addEventListener('open', () => {
      opened = true
      retryDelay = RETRY_INITIAL_MS
      handlers.onStatus('connected')
    })

    socket.addEventListener('message', ({ data }) => handlers.onData(String(data)))

    socket.addEventListener('close', () => {
      if (opened) {
        handlers.onStatus('disconnected')
      } else {
        handlers.onWarning(
          [
            `${url} につながりませんでした。${Math.round(retryDelay / 1000)}秒後にやり直します。`,
            'ゆかコネNEO が起動しているか、WebSocketのポート番号（既定 11901）が合っているかを確かめてください。',
            'ブラウザが ws:// への接続（混在コンテンツ）を拒んでいる可能性もあります。',
          ].join('\n'),
        )
      }
      window.setTimeout(open, retryDelay)
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
    })
  }

  open()
}
