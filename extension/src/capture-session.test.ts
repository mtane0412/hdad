/**
 * 拡張の中で取り込んで送るふるまい（offscreen document）のテスト
 *
 * 取り込み（getUserMedia）・中継先への接続・WebRTC の接続は偽物に差し替え、次を確かめる。
 * - 作った時点で中継先へつなぐ
 * - 届いたストリームIDで取り込み、合成ページへ名乗り直しを頼む
 * - 取り込めなかったら失敗として返す（IDの期限切れなど）
 * - 止めたら取り込みを止め、合成ページへ知らせる
 * - 別のタブのIDが届いたら、前の取り込みを止めて切り替える
 * - 取り込んだタブが閉じられたら、エラーにせず終わったことを知らせる
 * - つながっている合成ページの数と、待てば直るかもしれない失敗を、まとめた状態として知らせる
 */
import { describe, expect, it } from 'vitest'
import type { CapturedTab } from '../../src/tab/capture'
import type { SenderPeerHandlers } from '../../src/tab/sender'
import type { FromSender, FromViewer } from '../../src/tab/signal'
import type { TabSocketHandlers } from '../../src/tab/socket'
import { createCaptureSession } from './capture-session'
import type { OffscreenEvent } from './offscreen-event'

/** テストで映像の代わりに使う目印 */
type FakeStream = { readonly streamId: string }

const createHarness = (options: { failCapture?: string } = {}) => {
  const sent: FromSender[] = []
  const events: OffscreenEvent[] = []
  let socketHandlers: TabSocketHandlers<FromViewer> | null = null
  let socketClosed = false
  const captured: { streamId: string; stopped: boolean; end(): void }[] = []
  const peerHandlers: SenderPeerHandlers[] = []

  const session = createCaptureSession<FakeStream>({
    connect: (handlers) => {
      socketHandlers = handlers
      return {
        send: (message) => {
          sent.push(message)
          return true
        },
        close: () => {
          socketClosed = true
        },
      }
    },
    capture: async (streamId): Promise<CapturedTab<FakeStream>> => {
      if (options.failCapture !== undefined) throw new Error(options.failCapture)
      let endListener = (): void => undefined
      const entry = { streamId, stopped: false, end: () => endListener() }
      captured.push(entry)
      return {
        stream: { streamId },
        onEnded: (listener) => {
          endListener = listener
        },
        stop: () => {
          entry.stopped = true
        },
      }
    },
    openPeer: (_stream, handlers) => {
      peerHandlers.push(handlers)
      return { offer: async () => '申し込み', accept: async () => undefined, close: () => undefined }
    },
    report: (event) => events.push(event),
  })

  const socket = (): TabSocketHandlers<FromViewer> => {
    if (socketHandlers === null) throw new Error('中継先へつないでいません')
    return socketHandlers
  }
  return { session, sent, events, captured, peerHandlers, socket, socketClosed: () => socketClosed }
}

describe('createCaptureSession', () => {
  it('作った時点で中継先へつなぐ', () => {
    const harness = createHarness()

    expect(() => harness.socket()).not.toThrow()
  })

  it('届いたIDでタブを取り込み、合成ページへ名乗り直しを頼む', async () => {
    const harness = createHarness()

    await harness.session.start('ストリームID-1')

    expect(harness.captured.map((entry) => entry.streamId)).toEqual(['ストリームID-1'])
    expect(harness.sent).toEqual([{ type: 'who' }])
    expect(harness.events.at(-1)).toEqual({ type: 'state', viewers: 0, warning: null })
  })

  it('取り込めなかったら失敗として返す', async () => {
    const harness = createHarness({ failCapture: 'Error starting tab capture' })

    await expect(harness.session.start('期限切れのID')).rejects.toThrow('Error starting tab capture')
    expect(harness.sent).toEqual([])
  })

  it('止めたら取り込みを止め、合成ページへ知らせてから中継先との接続を切る', async () => {
    const harness = createHarness()
    await harness.session.start('ストリームID-1')

    harness.session.stop()

    expect(harness.captured[0]?.stopped).toBe(true)
    expect(harness.sent.at(-1)).toEqual({ type: 'stop' })
    expect(harness.socketClosed()).toBe(true)
  })

  it('別のタブのIDが届いたら、前の取り込みを止めて切り替える', async () => {
    const harness = createHarness()
    await harness.session.start('ストリームID-1')

    await harness.session.start('ストリームID-2')

    expect(harness.captured.map((entry) => ({ streamId: entry.streamId, stopped: entry.stopped }))).toEqual([
      { streamId: 'ストリームID-1', stopped: true },
      { streamId: 'ストリームID-2', stopped: false },
    ])
  })

  it('取り込んだタブが閉じられたら、エラーにせず終わったことを知らせる', async () => {
    const harness = createHarness()
    await harness.session.start('ストリームID-1')

    harness.captured[0]?.end()

    expect(harness.sent.at(-1)).toEqual({ type: 'stop' })
    expect(harness.events.at(-1)).toEqual({ type: 'ended' })
  })

  it('切り替えたあとに前のタブが閉じられても、終わったことにしない', async () => {
    const harness = createHarness()
    await harness.session.start('ストリームID-1')
    await harness.session.start('ストリームID-2')

    harness.captured[0]?.end()

    expect(harness.events).not.toContainEqual({ type: 'ended' })
  })

  it('つながっている合成ページの数を知らせる', async () => {
    const harness = createHarness()
    await harness.session.start('ストリームID-1')

    harness.socket().onMessage({ type: 'hello', viewerId: 'OBSの受け手' })
    harness.peerHandlers[0]?.onConnected()

    expect(harness.events.at(-1)).toEqual({ type: 'state', viewers: 1, warning: null })
  })

  it('中継先との接続が切れたら知らせ、つながり直したら知らせを消す', async () => {
    const harness = createHarness()
    await harness.session.start('ストリームID-1')

    harness.socket().onStatus('disconnected')
    expect(harness.events.at(-1)).toEqual({ type: 'state', viewers: 0, warning: '中継先との接続が切れました。つなぎ直しています…' })

    harness.socket().onOpen()
    expect(harness.events.at(-1)).toEqual({ type: 'state', viewers: 0, warning: null })
  })

  it('取り込みより先に届いた、中継先につながらない知らせを消さない', async () => {
    // ログインが切れていると、取り込み終える前に中継先から断られることがある
    const harness = createHarness()
    harness.socket().onWarning('タブの映像の中継先につながりません。Chrome で HDAD にログインしているか確かめてください')

    await harness.session.start('ストリームID-1')

    expect(harness.events.at(-1)).toEqual({
      type: 'state',
      viewers: 0,
      warning: 'タブの映像の中継先につながりません。Chrome で HDAD にログインしているか確かめてください',
    })
  })

  it('中継先につながらないときの手がかりを知らせる', async () => {
    const harness = createHarness()
    await harness.session.start('ストリームID-1')

    harness.socket().onWarning('タブの映像の中継先につながりません。Chrome で HDAD にログインしているか確かめてください')

    expect(harness.events.at(-1)).toEqual({
      type: 'state',
      viewers: 0,
      warning: 'タブの映像の中継先につながりません。Chrome で HDAD にログインしているか確かめてください',
    })
  })
})
