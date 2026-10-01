// @vitest-environment jsdom
/**
 * タブの映像の送り手の接続（connectTabSender）のテスト
 *
 * 送り手（拡張）は、配信者のセッションを WebSocket のプロトコルの欄で渡す（クッキーが付かないため）。
 * 本物の WebSocket の代わりに、渡されたプロトコルを記録する偽物を使い、次を確かめる。
 * - HDAD の置き場所の送り手の経路へ、[SENDER_PROTOCOL, セッション] を渡してつなぐ
 * - つなぎ直すときは、そのときのセッションを渡す（映し始めるたびにセッションを読み直すので、古い値で断られ続けないように）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SENDER_PROTOCOL } from './signal'
import { connectTabSender } from './socket'

/** 作られた WebSocket（偽物）の記録 */
const opened: { url: string; protocols: string[]; socket: FakeWebSocket }[] = []

class FakeWebSocket {
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  constructor(url: string, protocols: string[]) {
    opened.push({ url, protocols, socket: this })
  }
  send(): void {}
  close(): void {}
}

const handlers = { onMessage: () => undefined, onOpen: () => undefined, onStatus: () => undefined, onWarning: () => undefined }

beforeEach(() => {
  opened.length = 0
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('connectTabSender', () => {
  it('HDAD の置き場所の送り手の経路へ、プロトコルの欄でセッションを渡してつなぐ', () => {
    connectTabSender('https://hdad.example.workers.dev', () => '12345.1790000000.signature-a', handlers)

    expect(opened.map(({ url, protocols }) => ({ url, protocols }))).toEqual([
      { url: 'wss://hdad.example.workers.dev/api/admin/tab/socket', protocols: [SENDER_PROTOCOL, '12345.1790000000.signature-a'] },
    ])
  })

  it('つなぎ直すときは、そのときのセッションを渡す', () => {
    // 前提: つないだあと、配信者がログインし直してセッションが変わった
    let session = '12345.1790000000.signature-a'
    connectTabSender('https://hdad.example.workers.dev', () => session, handlers)
    session = '12345.1790600000.signature-b'

    // 接続が切れると、待ってからつなぎ直す
    opened[0]?.socket.onclose?.(new CloseEvent('close'))
    vi.runOnlyPendingTimers()

    expect(opened.map(({ protocols }) => protocols[1])).toEqual(['12345.1790000000.signature-a', '12345.1790600000.signature-b'])
  })
})
