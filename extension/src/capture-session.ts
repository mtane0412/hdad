/**
 * 拡張の中で取り込んで送るふるまい（offscreen document で動く）
 *
 * サービスワーカーから届いたストリームIDでタブを取り込み、合成ページの素材「タブの映像」へ WebRTC で送る。
 * 以前は HDAD の /tab/ が受け持っていたが、そのページを開いたままにしないと映らないのが不便だったので、拡張に移した。
 *
 * 映すタブは1枚ずつで、別のタブのIDが届いたらそのタブに切り替える。連絡への応じ方は src/tab/sender.ts、
 * WebRTC の接続は src/tab/peer.ts、中継先への接続は src/tab/socket.ts にあり、ここはそれらをつないで状態を知らせるだけにする
 * （テストではどれも偽物に差し替える）。
 *
 * 状態（つながっている合成ページの数と、待てば直るかもしれない失敗）は、変わるたびにまとめて report で知らせる。
 * サービスワーカーはそれをボタンの表示にする。
 *
 * 映しているタブが映さないサイトへ移ったら、サービスワーカーが pause で送るのだけを止めさせ、映してよいページへ戻ったら
 * resume で送り直させる（issue #165）。取り込みは保つので、配信者がボタンを押し直さずに済む。止めているあいだは
 * 合成ページとの接続をすべて閉じるので、映像は1枚も流れない（合成ページは透明に戻る）。
 *
 * 映す範囲（issue #166）は setCrop で受け取って送り手（src/tab/sender.ts）に渡す。別のタブを映し始めたら範囲を外す
 * （範囲は1つだけ持ち、選んだタブのためのものなので）。送るのを止めて送り直すときは同じタブなので外さない。
 *
 * 注意: 取り込んだタブが閉じられたら、エラーにせず「終わった」とだけ知らせる。配信中に普通に起こる操作のため。
 * 注意: IDは数秒で使えなくなる（#163 で、5秒後は使え、10秒後は失敗した）ので、受け取ったらすぐ取り込む。
 */
import type { CapturedTab } from '../../src/tab/capture'
import type { TabCrop } from '../../src/tab/crop'
import { createTabSender, type SenderPeer, type SenderPeerHandlers } from '../../src/tab/sender'
import type { FromSender, FromViewer } from '../../src/tab/signal'
import type { TabSocket, TabSocketHandlers } from '../../src/tab/socket'
import type { OffscreenEvent } from './offscreen-event'

/** 中継先との接続が切れたときの知らせ */
const RELAY_LOST = '中継先との接続が切れました。つなぎ直しています…'

export interface CaptureSessionOptions<S> {
  /** 送り手として中継先へつなぐ */
  connect(handlers: TabSocketHandlers<FromViewer>): TabSocket<FromSender>
  /** ストリームIDでタブを取り込む */
  capture(streamId: string): Promise<CapturedTab<S>>
  /** 合成ページ1つぶんの WebRTC の接続を作る */
  openPeer(stream: S, handlers: SenderPeerHandlers): SenderPeer
  /** サービスワーカーへ知らせる */
  report(event: OffscreenEvent): void
}

export interface CaptureSession {
  /**
   * このIDのタブを取り込んで映し始める（映していたものは、取り込めたあとで止める）。
   *
   * @throws 取り込めなかった場合（IDの期限切れ・タブが閉じられたなど）。映していたものはそのまま続く
   */
  start(streamId: string): Promise<void>
  /** 映すのをやめ、合成ページへ知らせてから中継先との接続を切る */
  stop(): void
  /** 取り込みは保ったまま、合成ページへ送るのをやめる（映さないサイトへ移ったとき） */
  pause(): void
  /** pause で止めていたなら、同じ取り込みで送り直す */
  resume(): void
  /** 映す範囲を変える（null はタブ全体） */
  setCrop(crop: TabCrop | null): void
}

/** 作った時点で中継先へつなぐ（offscreen document は映し始めるときに作られる） */
export const createCaptureSession = <S>(options: CaptureSessionOptions<S>): CaptureSession => {
  let current: CapturedTab<S> | null = null
  /** 取り込みの頼みの番号。前の取り込みが遅れて終わっても、新しい頼みを上書きしないために使う */
  let latestRequest = 0
  let viewers = 0
  let warning: string | null = null
  let socket: TabSocket<FromSender> | null = null
  /** pause で送るのを止めているか */
  let paused = false

  const reportState = (): void => {
    if (current !== null) options.report({ type: 'state', viewers, warning })
  }
  const warn = (message: string | null): void => {
    warning = message
    reportState()
  }

  const sender = createTabSender<S>({
    send: (message) => {
      socket?.send(message)
    },
    // 接続は合成ページの名前によらず同じ作り方なので、名前は渡さない
    openPeer: (_viewerId, stream, handlers) => options.openPeer(stream, handlers),
    onConnectedCount: (count) => {
      viewers = count
      reportState()
    },
    onWarning: warn,
  })
  socket = options.connect({
    onMessage: (message) => sender.receive(message),
    onOpen: () => {
      // 切れていた・つながらなかった知らせは、つながったら消す
      warn(null)
      sender.opened()
    },
    onStatus: (status) => {
      if (status === 'disconnected') warn(RELAY_LOST)
    },
    onWarning: warn,
  })

  const release = (): void => {
    current?.stop()
    current = null
  }

  return {
    start: async (streamId) => {
      latestRequest += 1
      const request = latestRequest
      const next = await options.capture(streamId)
      if (request !== latestRequest) {
        // 取り込んでいるあいだに、さらに別のタブが頼まれた
        next.stop()
        return
      }
      release()
      current = next
      // 別のタブを映し始めたら、前のタブのために止めていたことは忘れる（映してよいかはサービスワーカーが確かめてから頼む）
      paused = false
      // 範囲は前のタブで選んだものなので外す（新しいタブはまず全体を映す）
      sender.setCrop(null)
      next.onEnded(() => {
        if (current !== next) return
        // タブが閉じられた。エラーにはせず、合成ページを透明に戻して終わったことを知らせる
        release()
        sender.stop()
        options.report({ type: 'ended' })
      })
      sender.start(next.stream)
      // 失敗の知らせはここでは消さない。中継先につながらない知らせ（ログイン切れなど）は取り込みと前後して届くことがあり、
      // 消すと理由が分からないまま映らなくなる。知らせはつながったとき（onOpen）に消える
      reportState()
    },
    stop: () => {
      latestRequest += 1
      release()
      // 合成ページに映すのをやめたことを知らせてから切る（知らせないと、最後の絵が残ったまましばらく固まる）
      sender.stop()
      socket.close()
    },
    pause: () => {
      if (current === null || paused) return
      paused = true
      sender.stop()
    },
    resume: () => {
      if (!paused) return
      paused = false
      if (current !== null) sender.start(current.stream)
    },
    setCrop: (crop) => sender.setCrop(crop),
  }
}
