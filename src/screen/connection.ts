/**
 * OBS（obs-websocket v5）への接続
 *
 * OBS は動かしているPCの上に WebSocket サーバーを立てる（既定のポートは 4455。ツール > WebSocket サーバー設定）。
 * 裏方のページは OBS のブラウザソースとして同じPCの上で開かれる前提で、その localhost へつなぐ。
 *
 * ここは接続・名乗り（Identify）・要求と応答の結び付けだけを受け持ち、届いた1件の読み取りは protocol.ts に
 * 任せる（src/transcript/ と同じ分け方）。つなぎ直しは持たない。撮影は一定の間隔でしか起きないので、
 * 切れていたら次の撮影のときにつなぎ直せばよく、切れているあいだ試み続ける必要がない（src/screen/task.ts）。
 *
 * 注意: このページ自体は https で配信されるため、ws:// への接続は混在コンテンツにあたる。ブラウザは
 * localhost を安全な接続元として例外扱いするので通る見込みだが、OBS内蔵のCEFのバージョン次第である
 * （文字起こしの中継が同じ前提で動いている）。
 * 注意: つながらないまま閉じたときと、名乗りへの答え（Identified）が返ってこないまま待ち時間が過ぎたときは、
 * 黙って待ち続けずに失敗させる（Fail-Fast）。答えが返らないのは、OBSが応答しなくなった場合のほか、
 * 認証に失敗して OBS が閉じるのを待っているあいだにも起こりうる。
 * 注意: 名乗りが通る前に閉じられたときは、クローズコードで文面を分ける。パスワード違い（4009）を
 * 「つながりませんでした」に丸めると、配信者が待ち受けやブラウザの側を疑うことになる。
 */
import { authenticationOf, identifyMessage, readObsMessage, requestMessage } from './protocol'

/**
 * 名乗りが通る（Identified）まで待つ時間（ミリ秒）。
 *
 * これを過ぎたら待ち続けずに失敗させる。撮影は一定の間隔でしか起きないので、次の撮影のときにつなぎ直せばよい。
 */
export const CONNECT_TIMEOUT_MS = 10000

/**
 * obs-websocket がパスワード違いで切るときのクローズコード。
 *
 * この場合つないだ直後に切られるので、ほかの「つながらない」と同じ文面にすると、待ち受けやブラウザの側を
 * 疑うことになって原因にたどり着けない（実際に遠回りした。docs/decisions/screen.md）。
 */
const CLOSE_AUTHENTICATION_FAILED = 4009

/**
 * obs-websocket が自分の都合で切るときのクローズコードの下限。
 *
 * これ以上の番号で切られたということは、OBS には届いていて名乗りの途中で断られたということなので、
 * 起動や混在コンテンツを疑う文面を出さない。
 */
const CLOSE_OBS_MIN = 4000

/**
 * 接続に使う WebSocket の、このファイルが使う部分だけ。
 *
 * テストで差し替えられるよう、ブラウザの WebSocket そのものではなくこの形で受け取る。
 */
export interface ObsSocketEvents {
  /** 1件届いた（読み取りは protocol.ts が行う） */
  message: { data: unknown }
  /** 接続が閉じた。理由（クローズコード）が分かるものは、それも受け取る */
  close: { code?: number; reason?: string }
}

export interface ObsSocketLike {
  send(data: string): void
  close(): void
  addEventListener<Type extends keyof ObsSocketEvents>(type: Type, listener: (event: ObsSocketEvents[Type]) => void): void
}

/** つながった OBS への接続 */
export interface ObsConnection {
  /**
   * 要求を1つ送り、その応答を待つ。
   *
   * @throws OBS が要求を拒んだ場合、または答えが返る前に接続が閉じた場合
   */
  request(requestType: string, requestData?: Record<string, unknown>): Promise<Record<string, unknown>>
  /** まだつながっているか。切れていれば、呼び出し側はつなぎ直す */
  isOpen(): boolean
  /** こちらから閉じる */
  close(): void
}

export interface ConnectObsOptions {
  /** つなぎ先（ws://localhost:4455） */
  readonly url: string
  /** obs-websocket のパスワード。空なら認証のやりとりを行わない */
  readonly password: string
  /** WebSocket を作る。テストで差し替えるために受け取る */
  readonly createSocket: (url: string) => ObsSocketLike
}

/**
 * OBS へつなぎ、名乗りが通る（Identified）まで待つ。
 *
 * @throws つながらないまま閉じた場合、認証に失敗した場合、届いたものを読めなかった場合
 */
export const connectObs = ({ url, password, createSocket }: ConnectObsOptions): Promise<ObsConnection> =>
  new Promise<ObsConnection>((resolve, reject) => {
    const socket = createSocket(url)
    /** 答えを待っている要求。requestId で引く */
    const waiting = new Map<string, { resolve(data: Record<string, unknown>): void; reject(error: Error): void }>()
    let open = false
    let nextRequestId = 0

    /** 要求と応答を結び付けるためのID。1つの接続の中で重ならなければよい */
    const takeRequestId = (): string => {
      nextRequestId += 1
      return String(nextRequestId)
    }

    const connection: ObsConnection = {
      request: (requestType, requestData = {}) =>
        new Promise((resolveRequest, rejectRequest) => {
          if (!open) {
            rejectRequest(new Error(`${url} との接続が切れています`))
            return
          }
          const requestId = takeRequestId()
          waiting.set(requestId, { resolve: resolveRequest, reject: rejectRequest })
          socket.send(requestMessage(requestType, requestId, requestData))
        }),
      isOpen: () => open,
      close: () => socket.close(),
    }

    /** 名乗りが通らないまま時間が過ぎたら失敗させるための見張り。つながったら外す */
    const timer = setTimeout(() => {
      fail(new Error(`${url} へ名乗りましたが、応答がありません。OBSのWebSocketサーバー設定のパスワードが合っているかを確かめてください`))
      socket.close()
    }, CONNECT_TIMEOUT_MS)

    /** 接続が閉じた。つなぎに行った呼び出しと、答えを待っている要求のすべてを失敗させる */
    const fail = (error: Error): void => {
      open = false
      clearTimeout(timer)
      reject(error)
      for (const pending of waiting.values()) pending.reject(error)
      waiting.clear()
    }

    socket.addEventListener('message', (event) => {
      try {
        const message = readObsMessage(String(event.data))
        if (message.type === 'hello') {
          const { authentication } = message
          if (authentication === null) {
            if (password !== '') {
              // 認証を切っているOBSにパスワードを送っても通らないので、設定の食い違いとして知らせる
              throw new Error(`${url} は認証を求めていません。OBSのWebSocketサーバー設定に合わせて、パスワードを空にしてください`)
            }
            socket.send(identifyMessage(null))
            return
          }
          if (password === '') {
            throw new Error(`${url} は認証を求めています。OBSのWebSocketサーバー設定で決めたパスワードを、管理画面の画面の取り込みに入れてください`)
          }
          void authenticationOf(password, authentication.salt, authentication.challenge)
            .then((answer) => socket.send(identifyMessage(answer)))
            .catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))))
          return
        }
        if (message.type === 'identified') {
          open = true
          clearTimeout(timer)
          resolve(connection)
          return
        }
        if (message.type === 'response') {
          const pending = waiting.get(message.requestId)
          if (!pending) return
          waiting.delete(message.requestId)
          if (message.error === null) pending.resolve(message.data ?? {})
          else pending.reject(new Error(message.error))
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
        socket.close()
      }
    })

    /** 名乗りが通る前に閉じられたときの失敗。理由（クローズコード）ごとに、次に何を確かめればよいかを分ける */
    const failureOfClose = ({ code, reason }: { code?: number; reason?: string }): Error => {
      const 理由 = `クローズコード ${String(code)}${reason === undefined || reason === '' ? '' : `: ${reason}`}`
      if (code === CLOSE_AUTHENTICATION_FAILED) {
        return new Error(
          [
            `${url} のパスワードが違います（${理由}）。`,
            'OBSの ツール > WebSocketサーバー設定 > 接続情報を表示 でパスワードを確かめ、管理画面の画面の取り込みに入れ直してください。',
            '伏せ字のまま見本をコピーしても値は入りません。OBSで認証を切っているなら、パスワードは空にしてください。',
          ].join('\n'),
        )
      }
      if (code !== undefined && code >= CLOSE_OBS_MIN) {
        return new Error(
          [
            `${url} にはつながりましたが、名乗りが通る前に OBS から切られました（${理由}）。`,
            'OBSのWebSocketサーバー設定と、管理画面の画面の取り込みの設定が合っているかを確かめてください。',
          ].join('\n'),
        )
      }
      return new Error(
        [
          `${url} につながりませんでした。`,
          'OBSが起動していて、ツール > WebSocketサーバー設定 でサーバーが有効になっているかを確かめてください。',
          'ブラウザが ws:// への接続（混在コンテンツ）を拒んでいる可能性もあります。',
        ].join('\n'),
      )
    }

    socket.addEventListener('close', (event) => {
      fail(open ? new Error(`${url} との接続が切れました`) : failureOfClose(event))
    })
  })

/** 接続先のURLを組み立てる */
export const obsSocketUrl = (host: string, port: number): string => `ws://${host}:${port}`
