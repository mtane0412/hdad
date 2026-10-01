/**
 * 送り手（/tab/）のふるまいのテスト
 *
 * WebRTC の接続そのもの（RTCPeerConnection）はブラウザでしか作れないので、偽物に差し替えて、
 * 連絡への応じ方だけを確かめる。
 * - 映し始めたら合成ページに名乗り直しを頼み、名乗った合成ページごとに offer を送る
 * - 映していないあいだは名乗られても応じない
 * - つながっている合成ページには二重に offer を送らない
 * - 接続が切れたら（failed）作り直す（#163 の試作で、H.264 の最初の1回だけ送信が止まったため）
 * - 映すのをやめたら、すべての接続を閉じて合成ページに知らせる
 */
import { describe, expect, it } from 'vitest'
import type { FromSender } from './signal'
import { createTabSender, type SenderPeerHandlers } from './sender'

/** 作られた接続の n 番目（0 から数える）。無ければテストを失敗させる */
const nth = <T>(items: readonly T[], index: number): T => {
  const item = items[index]
  if (item === undefined) throw new Error(`${index + 1}本目の接続が作られていません`)
  return item
}

/** テストで映像の代わりに使う目印 */
type FakeStream = { readonly label: string }

/** 作られた接続を覚えておき、つながった・切れたをテストから起こせるようにする */
const createHarness = () => {
  const sent: FromSender[] = []
  const connectedCounts: number[] = []
  const warnings: string[] = []
  const peers: {
    viewerId: string
    stream: FakeStream
    answerSdp: string | null
    closed: boolean
    handlers: SenderPeerHandlers
  }[] = []
  const sender = createTabSender<FakeStream>({
    send: (message) => sent.push(message),
    openPeer: (viewerId, stream, handlers) => {
      const peer = { viewerId, stream, answerSdp: null as string | null, closed: false, handlers }
      peers.push(peer)
      return {
        offer: async () => `申し込み（${viewerId}・${stream.label}）`,
        accept: async (answerSdp) => {
          peer.answerSdp = answerSdp
        },
        close: () => {
          peer.closed = true
        },
      }
    },
    onConnectedCount: (count) => connectedCounts.push(count),
    onWarning: (message) => warnings.push(message),
  })
  return { sender, sent, connectedCounts, warnings, peers }
}

/** offer を作る非同期の処理が終わるのを待つ */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createTabSender', () => {
  it('映し始めたら、合成ページに名乗り直しを頼む', () => {
    const { sender, sent } = createHarness()

    sender.start({ label: '資料のタブ' })

    expect(sent).toEqual([{ type: 'who' }])
  })

  it('名乗った合成ページへ offer を送る', async () => {
    const { sender, sent } = createHarness()
    sender.start({ label: '資料のタブ' })

    sender.receive({ type: 'hello', viewerId: 'OBSの受け手' })
    await settle()

    expect(sent).toEqual([{ type: 'who' }, { type: 'offer', viewerId: 'OBSの受け手', sdp: '申し込み（OBSの受け手・資料のタブ）' }])
  })

  it('映していないあいだは、名乗られても offer を送らない', async () => {
    const { sender, sent, peers } = createHarness()

    sender.receive({ type: 'hello', viewerId: 'OBSの受け手' })
    await settle()

    expect(peers).toEqual([])
    expect(sent).toEqual([])
  })

  it('answer を、その合成ページの接続に渡す', async () => {
    const { sender, peers } = createHarness()
    sender.start({ label: '資料のタブ' })
    sender.receive({ type: 'hello', viewerId: 'OBSの受け手' })

    sender.receive({ type: 'answer', viewerId: 'OBSの受け手', sdp: '回答1' })
    await settle()

    expect(peers.map((peer) => peer.answerSdp)).toEqual(['回答1'])
  })

  it('つながっている合成ページが名乗り直しても、接続を作り直さない', async () => {
    // 名乗り直しは全員に頼むので、つながっている合成ページも名乗る
    const { sender, peers } = createHarness()
    sender.start({ label: '資料のタブ' })
    sender.receive({ type: 'hello', viewerId: 'OBSの受け手' })
    nth(peers, 0).handlers.onConnected()

    sender.receive({ type: 'hello', viewerId: 'OBSの受け手' })

    expect(peers).toHaveLength(1)
    expect(nth(peers, 0).closed).toBe(false)
  })

  it('まだつながっていない合成ページが名乗り直したら、接続を作り直す', () => {
    // OBS がブラウザソースを読み込み直したときに起こる（前の接続の answer は二度と届かない）
    const { sender, peers } = createHarness()
    sender.start({ label: '資料のタブ' })
    sender.receive({ type: 'hello', viewerId: 'OBSの受け手' })

    sender.receive({ type: 'hello', viewerId: 'OBSの受け手' })

    expect(peers.map((peer) => peer.closed)).toEqual([true, false])
  })

  it('つながっている合成ページの数を知らせる', () => {
    const { sender, connectedCounts, peers } = createHarness()
    sender.start({ label: '資料のタブ' })
    sender.receive({ type: 'hello', viewerId: 'OBSの受け手' })
    sender.receive({ type: 'hello', viewerId: '別のシーンの受け手' })

    nth(peers, 0).handlers.onConnected()
    nth(peers, 1).handlers.onConnected()

    expect(connectedCounts.at(-1)).toBe(2)
  })

  it('接続が切れたら閉じて、名乗り直しを頼む（名乗った合成ページへ作り直す）', () => {
    const { sender, sent, peers } = createHarness()
    sender.start({ label: '資料のタブ' })
    sender.receive({ type: 'hello', viewerId: 'OBSの受け手' })

    nth(peers, 0).handlers.onFailed()
    sender.receive({ type: 'hello', viewerId: 'OBSの受け手' })

    expect(peers.map((peer) => peer.closed)).toEqual([true, false])
    expect(sent.filter((message) => message.type === 'who')).toHaveLength(2)
  })

  it('別のタブを映し始めたら、前の接続を閉じて新しい映像で作り直す', () => {
    const { sender, peers } = createHarness()
    sender.start({ label: '資料のタブ' })
    sender.receive({ type: 'hello', viewerId: 'OBSの受け手' })

    sender.start({ label: '動画のタブ' })
    sender.receive({ type: 'hello', viewerId: 'OBSの受け手' })

    expect(peers.map((peer) => [peer.stream.label, peer.closed])).toEqual([
      ['資料のタブ', true],
      ['動画のタブ', false],
    ])
  })

  it('映すのをやめたら、すべての接続を閉じて合成ページに知らせる', () => {
    const { sender, sent, peers, connectedCounts } = createHarness()
    sender.start({ label: '資料のタブ' })
    sender.receive({ type: 'hello', viewerId: 'OBSの受け手' })
    nth(peers, 0).handlers.onConnected()

    sender.stop()

    expect(nth(peers, 0).closed).toBe(true)
    expect(sent.at(-1)).toEqual({ type: 'stop' })
    expect(connectedCounts.at(-1)).toBe(0)
  })

  it('中継先へつなぎ直したら、映しているときだけ名乗り直しを頼む', () => {
    const { sender, sent } = createHarness()

    sender.opened()
    sender.start({ label: '資料のタブ' })
    sender.opened()

    expect(sent).toEqual([{ type: 'who' }, { type: 'who' }])
  })

  it('offer を作れなかったら知らせる', async () => {
    const warnings: string[] = []
    const sender = createTabSender<FakeStream>({
      send: () => undefined,
      openPeer: () => ({
        offer: async () => {
          throw new Error('H.264 で送れません')
        },
        accept: async () => undefined,
        close: () => undefined,
      }),
      onConnectedCount: () => undefined,
      onWarning: (message) => warnings.push(message),
    })
    sender.start({ label: '資料のタブ' })

    sender.receive({ type: 'hello', viewerId: 'OBSの受け手' })
    await settle()

    expect(warnings).toEqual(['合成ページへ映像を送れませんでした: H.264 で送れません'])
  })
})
