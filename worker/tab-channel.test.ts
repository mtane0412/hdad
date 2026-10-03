/**
 * タブの映像をつなぐ連絡の中継（Durable Object）のテスト
 *
 * WebSocketの接続そのもの（Upgrade）は Cloudflare のランタイムでしか作れないため、ここでは確かめない。
 * 確かめるのは、手書きの中継と違って両方向に配ること（送り手 → 合成ページ、合成ページ → 送り手）、
 * そして同じ側どうしには配らないことである。
 */
import { describe, expect, it } from 'vitest'
import { SENDER, TabChannel, VIEWER, type TabChannelState, type TabSocket, revokeTabViewers } from './tab-channel'
import { createFakeTabChannel } from './fake-tab-channel'

/** 送られた文字列を覚えておく、テスト用の接続 */
const createConnection = (): TabSocket & { sentMessages: string[] } => {
  const sentMessages: string[] = []
  return { sentMessages, send: (message) => sentMessages.push(message), close: () => {} }
}

/** 接続とその役割を覚えておく、テスト用の保持の仕組み */
const createStorage = (connections: readonly (readonly [TabSocket, string])[]): TabChannelState => ({
  acceptWebSocket: () => {},
  getWebSockets: () => connections.map(([socket]) => socket),
  getTags: (socket) => connections.find(([candidate]) => candidate === socket)?.[1].split(',') ?? [],
  setWebSocketAutoResponse: () => {},
})

describe('TabChannel', () => {
  it('送り手から届いた連絡を、合成ページへ配る', () => {
    const senderPage = createConnection()
    const obsStage = createConnection()
    const channel = new TabChannel(createStorage([
      [senderPage, SENDER],
      [obsStage, VIEWER],
    ]))

    channel.webSocketMessage(senderPage, '{"type":"who"}')

    expect(obsStage.sentMessages).toEqual(['{"type":"who"}'])
    expect(senderPage.sentMessages).toEqual([])
  })

  it('合成ページから届いた連絡を、送り手へ配る', () => {
    const senderPage = createConnection()
    const obsStage = createConnection()
    const channel = new TabChannel(createStorage([
      [senderPage, SENDER],
      [obsStage, VIEWER],
    ]))

    channel.webSocketMessage(obsStage, '{"type":"hello","viewerId":"OBSの受け手"}')

    expect(senderPage.sentMessages).toEqual(['{"type":"hello","viewerId":"OBSの受け手"}'])
  })

  it('合成ページから届いた連絡は、ほかの合成ページへ配らない', () => {
    // オーバーレイ用キーは配信画面に映りうるので、それを持つだけで他の合成ページへ offer を送り込めないようにする
    const obsStage = createConnection()
    const anotherStage = createConnection()
    const channel = new TabChannel(createStorage([
      [obsStage, VIEWER],
      [anotherStage, VIEWER],
    ]))

    channel.webSocketMessage(obsStage, '{"type":"offer","viewerId":"別の受け手","sdp":"v=0"}')

    expect(anotherStage.sentMessages).toEqual([])
  })

  it('文字列でないものは配らない', () => {
    const senderPage = createConnection()
    const obsStage = createConnection()
    const channel = new TabChannel(createStorage([
      [senderPage, SENDER],
      [obsStage, VIEWER],
    ]))

    channel.webSocketMessage(senderPage, new ArrayBuffer(8))

    expect(obsStage.sentMessages).toEqual([])
  })
})

describe('オーバーレイ用キーの再発行に伴う切断', () => {
  /** 閉じられたかどうかを覚えておく、テスト用の接続 */
  const createClosableConnection = (): TabSocket & { closedWith: number[] } => {
    const closedWith: number[] = []
    return { closedWith, send: () => {}, close: (code) => closedWith.push(code ?? 0) }
  }

  it('POST /revoke を受けたら、合成ページの接続（オーバーレイ用キーで開かれたもの）だけを閉じる', () => {
    const senderPage = createClosableConnection()
    const obsStage = createClosableConnection()
    const channel = new TabChannel(createStorage([
      [senderPage, SENDER],
      [obsStage, VIEWER],
    ]))

    const response = channel.fetch(new Request('https://tab-channel/revoke', { method: 'POST' }))

    expect(response.status).toBe(204)
    expect(obsStage.closedWith).toEqual([4001])
    // 送り手（拡張）は配信者のセッションで開かれているので、キーの再発行とは関係なく残す
    expect(senderPage.closedWith).toEqual([])
  })

  it('revokeTabViewers は Durable Object へ切断を頼む', async () => {
    const relay = createFakeTabChannel()

    await revokeTabViewers(relay.namespace)

    expect(relay.revocations).toBe(1)
    expect(relay.forwardedConnections).toEqual([])
  })
})
