/**
 * 合成ページ（素材 `tab`）の受け手のふるまい
 *
 * 送り手（/tab/）からの連絡（src/tab/signal.ts）に応じて、WebRTC の接続を作り直したり閉じたりする。
 * 接続そのもの（RTCPeerConnection）とWebSocketは外から受け取り、ここは「いつ名乗り、どの offer に応じ、
 * いつ映すのをやめるか」だけを決める（テストで偽物に差し替えるため）。
 *
 * 映すのは常に最新の接続から届いた映像だけである。送り手がタブを切り替えると新しい offer が届くので、前の接続は閉じる。
 *
 * 注意: 送り手が映すのをやめたとき・接続が切れたときは、何も映さない状態に戻すだけでエラーにしない。
 * タブを閉じる・送り手のページを閉じるのは配信中に普通に起こる操作なので、素材の枠に失敗を出さない（issue #164）。
 */
import type { FromSender, FromViewer } from './signal'

/** 受け手の接続1本が知らせること */
export interface ReceiverPeerHandlers<S> {
  /** 映像（と音）が届いた */
  onStream(stream: S): void
  /** 接続が切れて戻らない（failed）。送り手のページやタブが閉じられたときに起こる */
  onClosed(): void
}

/** 受け手の接続1本 */
export interface ReceiverPeer {
  /**
   * 届いた offer に答える。
   *
   * @returns 送り手へ返す answer の SDP（ICE の候補を集め終えたもの）
   */
  answer(offerSdp: string): Promise<string>
  close(): void
}

export interface TabReceiverOptions<S> {
  /** この合成ページを指す名前。合成ページが複数あっても、送り手は名前ごとに接続を分ける */
  viewerId: string
  /** 送り手へ連絡を送る（つながっていなければ送れずに落ちてよい。つながったときに名乗り直す） */
  send(message: FromViewer): void
  /** 接続を1本作る */
  openPeer(handlers: ReceiverPeerHandlers<S>): ReceiverPeer
  /** 映すものが変わった（null は何も映さない） */
  onStream(stream: S | null): void
  /** 待てば直るかもしれない失敗 */
  onWarning(message: string): void
}

export interface TabReceiver {
  /** 中継先へつながった（つなぎ直しも含む） */
  opened(): void
  /** 送り手から連絡が届いた */
  receive(message: FromSender): void
}

export const createTabReceiver = <S>(options: TabReceiverOptions<S>): TabReceiver => {
  const { viewerId, send } = options
  let current: ReceiverPeer | null = null
  /** いま何かを映しているか。映していないのに「何も映さない」を知らせ直さないために持つ */
  let showing = false

  const hello = (): void => send({ type: 'hello', viewerId })

  /** いまの接続を閉じ、何も映さない状態にする */
  const closeCurrent = (): void => {
    if (current === null) return
    current.close()
    current = null
    if (!showing) return
    showing = false
    options.onStream(null)
  }

  const accept = (offerSdp: string): void => {
    closeCurrent()
    const peer: ReceiverPeer = options.openPeer({
      // 閉じた古い接続から遅れて届いたものは映さない（切り替える前のタブが映り戻らないように）
      onStream: (stream) => {
        if (current !== peer) return
        showing = true
        options.onStream(stream)
      },
      onClosed: () => {
        if (current === peer) closeCurrent()
      },
    })
    current = peer
    peer
      .answer(offerSdp)
      .then((sdp) => {
        if (current === peer) send({ type: 'answer', viewerId, sdp })
      })
      .catch((error: unknown) => {
        // 失敗した接続は閉じる（送り手は、次に名乗ったときに作り直す）
        if (current === peer) closeCurrent()
        options.onWarning(`タブの映像を受け取れませんでした: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  return {
    opened: hello,
    receive: (message) => {
      switch (message.type) {
        case 'who':
          hello()
          return
        case 'offer':
          if (message.viewerId === viewerId) accept(message.sdp)
          return
        case 'stop':
          closeCurrent()
          return
      }
    },
  }
}
