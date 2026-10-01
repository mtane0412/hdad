// @vitest-environment jsdom
/**
 * 送り手のページ（/tab/）のテスト
 *
 * 取り込み（getUserMedia）・中継先への接続・WebRTC の接続は偽物に差し替え、次を確かめる。
 * - 開いただけなら「映していません」と出し、中継先へつなぐ
 * - 拡張が URL の # でストリームIDを渡したら、そのIDで取り込み、映しているタブの題名を出し、# を消す
 * - 取り込めなかったら理由を出す（ID の期限切れなど）
 * - 「止める」で取り込みを止め、合成ページへ知らせる
 * - 取り込んだタブが閉じられたら、エラーにせず「映していません」に戻る
 * - つながっている合成ページの数を出す
 * - Chrome 拡張をこの置き場所用にダウンロードできる
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SenderPeerHandlers } from './sender'
import { buildStreamHash, type FromSender, type FromViewer } from './signal'
import type { TabSocketHandlers } from './socket'
import { TabPage, type CapturedTab } from './tab-page'

/** テストで映像の代わりに使う目印 */
type FakeStream = { readonly streamId: string }

const createHarness = (options: { failCapture?: string } = {}) => {
  const sent: FromSender[] = []
  let socketHandlers: TabSocketHandlers<FromViewer> | null = null
  const captured: { streamId: string; stopped: boolean; end(): void }[] = []
  const peerHandlers: SenderPeerHandlers[] = []

  const props = {
    connect: (handlers: TabSocketHandlers<FromViewer>) => {
      socketHandlers = handlers
      return {
        send: (message: FromSender) => {
          sent.push(message)
          return true
        },
        close: () => undefined,
      }
    },
    capture: async (streamId: string): Promise<CapturedTab<FakeStream>> => {
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
    openPeer: (_stream: FakeStream, handlers: SenderPeerHandlers) => {
      peerHandlers.push(handlers)
      return { offer: async () => '申し込み', accept: async () => undefined, close: () => undefined }
    },
  }
  /** 中継先から合成ページの連絡が届いたことにする */
  const deliver = (message: FromViewer) =>
    act(() => {
      if (socketHandlers === null) throw new Error('中継先へつないでいません')
      socketHandlers.onMessage(message)
    })
  return { props, sent, captured, peerHandlers, deliver, connected: () => socketHandlers !== null }
}

/** 拡張が送り手のタブの # を書き換えたときと同じことを起こす */
const handOver = (streamId: string, title: string) =>
  act(() => {
    window.history.replaceState(null, '', `/tab/${buildStreamHash({ streamId, title })}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })

beforeEach(() => {
  window.history.replaceState(null, '', '/tab/')
})

afterEach(cleanup)

describe('TabPage', () => {
  it('開いただけなら「映していません」と出し、中継先へつなぐ', () => {
    const harness = createHarness()

    render(<TabPage {...harness.props} />)

    expect(screen.getByText('映していません')).toBeTruthy()
    expect(harness.connected()).toBe(true)
  })

  it('拡張から届いたIDでタブを取り込み、題名を出して # を消す', async () => {
    const harness = createHarness()
    render(<TabPage {...harness.props} />)

    await handOver('ストリームID-1', '配信の資料 - Google スライド')

    expect(await screen.findByText('配信の資料 - Google スライド')).toBeTruthy()
    expect(harness.captured.map((entry) => entry.streamId)).toEqual(['ストリームID-1'])
    expect(harness.sent).toEqual([{ type: 'who' }])
    expect(window.location.hash).toBe('')
  })

  it('描き始めた時点で # にIDがあれば、そのまま取り込む', async () => {
    // ページを読み込んでいる途中に拡張が # を書き換えると、hashchange より先に描き始めることがある
    const harness = createHarness()
    window.history.replaceState(null, '', `/tab/${buildStreamHash({ streamId: 'ストリームID-1', title: '動画のタブ' })}`)

    render(<TabPage {...harness.props} />)

    expect(await screen.findByText('動画のタブ')).toBeTruthy()
  })

  it('取り込めなかったら理由を出す', async () => {
    const harness = createHarness({ failCapture: 'Error starting tab capture' })
    render(<TabPage {...harness.props} />)

    await handOver('期限切れのID', '資料のタブ')

    expect(await screen.findByText(/Error starting tab capture/)).toBeTruthy()
  })

  it('「止める」で取り込みを止め、合成ページへ知らせる', async () => {
    const harness = createHarness()
    render(<TabPage {...harness.props} />)
    await handOver('ストリームID-1', '資料のタブ')
    await screen.findByText('資料のタブ')

    await userEvent.click(screen.getByRole('button', { name: '止める' }))

    expect(harness.captured[0]?.stopped).toBe(true)
    expect(harness.sent.at(-1)).toEqual({ type: 'stop' })
    expect(screen.getByText('映していません')).toBeTruthy()
  })

  it('別のタブのIDが届いたら、前の取り込みを止めて切り替える', async () => {
    const harness = createHarness()
    render(<TabPage {...harness.props} />)
    await handOver('ストリームID-1', '資料のタブ')
    await screen.findByText('資料のタブ')

    await handOver('ストリームID-2', '動画のタブ')

    expect(await screen.findByText('動画のタブ')).toBeTruthy()
    expect(harness.captured.map((entry) => entry.stopped)).toEqual([true, false])
  })

  it('取り込んだタブが閉じられたら、エラーにせず「映していません」に戻る', async () => {
    const harness = createHarness()
    render(<TabPage {...harness.props} />)
    await handOver('ストリームID-1', '資料のタブ')
    await screen.findByText('資料のタブ')

    act(() => harness.captured[0]?.end())

    expect(screen.getByText('映していません')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(harness.sent.at(-1)).toEqual({ type: 'stop' })
  })

  it('Chrome 拡張をダウンロードできる', () => {
    // 拡張には、ダウンロードしたときの置き場所を信頼する設定が入る（worker/tab-extension.ts）
    const harness = createHarness()

    render(<TabPage {...harness.props} />)

    expect(screen.getByRole('link', { name: '拡張をダウンロード' }).getAttribute('href')).toBe('/api/admin/tab/extension.zip')
  })

  it('つながっている合成ページの数を出す', async () => {
    const harness = createHarness()
    render(<TabPage {...harness.props} />)
    await handOver('ストリームID-1', '資料のタブ')
    await screen.findByText('資料のタブ')

    await harness.deliver({ type: 'hello', viewerId: 'OBSの受け手' })
    act(() => harness.peerHandlers[0]?.onConnected())

    expect(screen.getByText('合成ページ 1 か所に映しています')).toBeTruthy()
  })
})
