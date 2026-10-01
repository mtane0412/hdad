/**
 * 拡張の offscreen document
 *
 * サービスワーカー（background.ts）から届いた頼みに応じて、タブを取り込み、HDAD の合成ページへ WebRTC で送る。
 * ふるまいは capture-session.ts にあり、ここは Chrome の API とブラウザの取り込み・接続をつなぐだけにする。
 *
 * 中継先へは、config.json に書かれた HDAD の置き場所へ配信者のセッションでつなぐ。offscreen document からの WebSocket には
 * クッキーが付かないので、サービスワーカーが chrome.cookies で読んだセッションを WebSocket のプロトコルの欄で渡す
 * （src/tab/socket.ts の connectTabSender）。
 *
 * 注意: 頼みの形が違う・取り込めないときは、黙らずに理由を返事で返す（サービスワーカーがバッジで知らせる）。
 */
import { captureTab } from '../../src/tab/capture'
import { openSenderPeer } from '../../src/tab/peer'
import { connectTabSender } from '../../src/tab/socket'
import { createCaptureSession, type CaptureSession } from './capture-session'
import { parseOffscreenCommand, type OffscreenReply } from './offscreen-command'
import type { OffscreenEvent, OffscreenEventMessage } from './offscreen-event'

/** 失敗の理由を返事の文にする（guards.ts の reasonOf はサービスワーカー側なので読み込まない。共有のファイルを作らないため） */
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** サービスワーカーへ知らせる */
const report = (event: OffscreenEvent): void => {
  const message: OffscreenEventMessage = { target: 'background', ...event }
  chrome.runtime.sendMessage(message).catch((error: unknown) => {
    // サービスワーカーは呼べば起きるので、届かないのは拡張が読み込み直された途中などに限られる
    console.error('サービスワーカーへ知らせられませんでした', event, error)
  })
}

let captureSession: CaptureSession | null = null
/** いちばん新しく受け取った配信者のセッション。中継先へつなぎ直すたびに読む（映し始めるたびに読み直した値に置き換える） */
let latestSession = ''

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (reply: OffscreenReply) => void) => {
  let command
  try {
    command = parseOffscreenCommand(message)
  } catch (error) {
    sendResponse({ ok: false, message: reasonOf(error) })
    return false
  }
  if (command === null) return false

  if (command.type === 'stop') {
    captureSession?.stop()
    captureSession = null
    sendResponse({ ok: true })
    return false
  }
  if (command.type === 'pause' || command.type === 'resume') {
    if (captureSession === null) {
      // 映していないのに頼まれた（サービスワーカーの記録と食い違っている）。黙らずに返す
      sendResponse({ ok: false, message: 'タブを映していません' })
      return false
    }
    if (command.type === 'pause') captureSession.pause()
    else captureSession.resume()
    sendResponse({ ok: true })
    return false
  }
  // 中継先への接続は、最初に映し始めたときの置き場所で作る（止めるまで offscreen document ごと持ち続ける）。
  // セッションはつなぎ直すたびに読むので、切り替えのたびに受け取る新しい値に置き換える
  const { origin, streamId, session } = command
  latestSession = session
  captureSession ??= createCaptureSession({
    connect: (handlers) => connectTabSender(origin, () => latestSession, handlers),
    capture: captureTab,
    openPeer: openSenderPeer,
    report,
  })
  captureSession.start(streamId).then(
    () => sendResponse({ ok: true }),
    (error: unknown) => sendResponse({ ok: false, message: reasonOf(error) }),
  )
  // 返事を非同期で送るので true を返す（Chrome の決まり）
  return true
})
