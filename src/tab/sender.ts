/**
 * 送り手（/tab/）のふるまい
 *
 * 取り込んだタブの映像を、名乗った合成ページごとに WebRTC で送る。接続そのもの（RTCPeerConnection）と
 * WebSocketは外から受け取り、ここは「いつ名乗り直しを頼み、どの合成ページへ offer を送り、いつ作り直すか」だけを決める
 * （テストで偽物に差し替えるため）。連絡の形は src/tab/signal.ts にある。
 *
 * 合成ページは OBS の別のシーンなどで複数ありうるので、接続は合成ページの名前（viewerId）ごとに1本持つ。
 * 映すタブを切り替えたら、すべての接続を閉じて新しい映像で作り直す。
 *
 * 接続が切れたら（failed）閉じて名乗り直しを頼み、名乗った合成ページへ作り直す。#163 の試作で、H.264 の最初の1回だけ
 * 送信が止まったまま failed になったことがあり（原因は特定できていない）、作り直せば映ったため。
 * 合成ページが閉じられていれば名乗る相手がいないので、作り直しは起こらない。
 */
import type { FromSender, FromViewer } from './signal'

/** 送り手の接続1本が知らせること */
export interface SenderPeerHandlers {
  /** 合成ページとつながった */
  onConnected(): void
  /** 接続が切れて戻らない（failed） */
  onFailed(): void
}

/** 送り手の接続1本（合成ページ1つぶん） */
export interface SenderPeer {
  /**
   * offer を作る。
   *
   * @returns 合成ページへ送る offer の SDP（ICE の候補を集め終えたもの）
   */
  offer(): Promise<string>
  /** 合成ページから届いた answer を受け取る */
  accept(answerSdp: string): Promise<void>
  close(): void
}

export interface TabSenderOptions<S> {
  /** 合成ページへ連絡を送る（つながっていなければ送れずに落ちてよい。つながったときに名乗り直しを頼む） */
  send(message: FromSender): void
  /** 合成ページ1つぶんの接続を作る */
  openPeer(viewerId: string, stream: S, handlers: SenderPeerHandlers): SenderPeer
  /** つながっている合成ページの数が変わった（送り手のページの表示に使う） */
  onConnectedCount(count: number): void
  /** 待てば直るかもしれない失敗 */
  onWarning(message: string): void
}

export interface TabSender<S> {
  /** このタブの映像を映し始める（映していたものは置き換える） */
  start(stream: S): void
  /** 映すのをやめる */
  stop(): void
  /** 中継先へつながった（つなぎ直しも含む） */
  opened(): void
  /** 合成ページから連絡が届いた */
  receive(message: FromViewer): void
}

/** 合成ページ1つぶんの接続と、つながったかどうか */
interface PeerEntry {
  readonly peer: SenderPeer
  connected: boolean
}

export const createTabSender = <S>(options: TabSenderOptions<S>): TabSender<S> => {
  const { send } = options
  let stream: S | null = null
  const peers = new Map<string, PeerEntry>()

  const reportConnected = (): void => options.onConnectedCount([...peers.values()].filter((entry) => entry.connected).length)

  const closeAll = (): void => {
    for (const entry of peers.values()) entry.peer.close()
    peers.clear()
    reportConnected()
  }

  /** その合成ページへの接続を作り、offer を送る */
  const connect = (viewerId: string, current: S): void => {
    const entry: PeerEntry = {
      connected: false,
      peer: options.openPeer(viewerId, current, {
        onConnected: () => {
          if (peers.get(viewerId) !== entry) return
          entry.connected = true
          reportConnected()
        },
        onFailed: () => {
          // 閉じた古い接続の知らせは無視する（作り直したあとの接続まで閉じないように）
          if (peers.get(viewerId) !== entry) return
          entry.peer.close()
          peers.delete(viewerId)
          reportConnected()
          // まだ開いている合成ページは名乗るので、そこへ作り直す
          send({ type: 'who' })
        },
      }),
    }
    peers.set(viewerId, entry)
    entry.peer
      .offer()
      .then((sdp) => {
        if (peers.get(viewerId) === entry) send({ type: 'offer', viewerId, sdp })
      })
      .catch((error: unknown) => {
        options.onWarning(`合成ページへ映像を送れませんでした: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  const hello = (viewerId: string): void => {
    if (stream === null) return
    const existing = peers.get(viewerId)
    // 名乗り直しは全員に頼むので、つながっている合成ページも名乗る。そこは作り直さない
    if (existing?.connected === true) return
    // まだつながっていない接続は、合成ページが読み込み直されて answer が二度と届かないかもしれないので作り直す
    existing?.peer.close()
    connect(viewerId, stream)
  }

  const answer = (viewerId: string, sdp: string): void => {
    // 閉じたあとの接続への answer（作り直す前の offer への返事）は捨てる
    const entry = peers.get(viewerId)
    if (entry === undefined) return
    entry.peer.accept(sdp).catch((error: unknown) => {
      options.onWarning(`合成ページとつなげませんでした: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  return {
    start: (next) => {
      closeAll()
      stream = next
      send({ type: 'who' })
    },
    stop: () => {
      closeAll()
      stream = null
      send({ type: 'stop' })
    },
    opened: () => {
      if (stream !== null) send({ type: 'who' })
    },
    receive: (message) => {
      switch (message.type) {
        case 'hello':
          hello(message.viewerId)
          return
        case 'answer':
          answer(message.viewerId, message.sdp)
          return
      }
    },
  }
}
