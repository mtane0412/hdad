/**
 * 手書きの線の中継（Durable Object）のテスト
 *
 * WebSocketの接続そのもの（Upgrade）は Cloudflare のランタイムでしか作れないため、ここでは確かめない。
 * 確かめるのは、描く画面から届いた線を他の接続へ配ること、送り主自身へは返さないこと、
 * そして合成ページ（見るだけの接続）から送られてきたものは配らないことである。
 */
import { describe, expect, it } from 'vitest'
import { DrawChannel, WRITER, VIEWER, connectDrawSocket, revokeRelayViewers, type DrawSocket, type DrawChannelState } from './draw-channel'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeDurableStorage } from './fake-durable-storage'

/** 送られた文字列を覚えておく、テスト用の接続 */
const createConnection = (): DrawSocket & { sentMessages: string[] } => {
  const sentMessages: string[] = []
  return { sentMessages, send: (message) => sentMessages.push(message), close: () => {} }
}

/** 接続とその役割を覚えておく、テスト用の保持の仕組み */
const createStorage = (
  connections: readonly (readonly [DrawSocket, string])[],
): DrawChannelState & { acceptedRoles: string[][] } => {
  const acceptedRoles: string[][] = []
  return {
    acceptedRoles,
    acceptWebSocket: (_socket, tags) => acceptedRoles.push([...(tags ?? [])]),
    getWebSockets: () => connections.map(([socket]) => socket),
    getTags: (socket) => connections.find(([candidate]) => candidate === socket)?.[1].split(',') ?? [],
    setWebSocketAutoResponse: () => {},
    storage: createFakeDurableStorage(),
  }
}

describe('DrawChannel', () => {
  it('描く画面から届いた線を、他の接続へ配る', () => {
    const drawScreen = createConnection()
    const stagePage = createConnection()
    const channel = new DrawChannel(createStorage([
      [drawScreen, WRITER],
      [stagePage, VIEWER],
    ]))

    channel.webSocketMessage(drawScreen, '{"type":"start","id":"線1","point":{"x":0.1,"y":0.2}}')

    expect(stagePage.sentMessages).toEqual(['{"type":"start","id":"線1","point":{"x":0.1,"y":0.2}}'])
  })

  it('送り主自身へは返さない', () => {
    // 描く画面は自分のキャンバスへ直接描いているので、返すと同じ線を二重に持つことになる
    const drawScreen = createConnection()
    const channel = new DrawChannel(createStorage([[drawScreen, WRITER]]))

    channel.webSocketMessage(drawScreen, '{"type":"start","id":"線1","point":{"x":0.1,"y":0.2}}')

    expect(drawScreen.sentMessages).toEqual([])
  })

  it('見るだけの接続から送られてきたものは配らない', () => {
    // オーバーレイ用キーは配信画面に映りうるので、それを持つだけでは他人の画面に描けないようにする
    const stagePage = createConnection()
    const anotherStagePage = createConnection()
    const channel = new DrawChannel(createStorage([
      [stagePage, VIEWER],
      [anotherStagePage, VIEWER],
    ]))

    channel.webSocketMessage(stagePage, '{"type":"start","id":"線1","point":{"x":0.1,"y":0.2}}')

    expect(anotherStagePage.sentMessages).toEqual([])
  })

  it('文字列でないものは配らない', () => {
    // 描く画面は文字列しか送らない。それ以外が届いたら、送り手の作りを疑う
    const drawScreen = createConnection()
    const stagePage = createConnection()
    const channel = new DrawChannel(createStorage([
      [drawScreen, WRITER],
      [stagePage, VIEWER],
    ]))

    channel.webSocketMessage(drawScreen, new ArrayBuffer(8))

    expect(stagePage.sentMessages).toEqual([])
  })
})

describe('オーバーレイ用キーの再発行に伴う切断', () => {
  /** 閉じられたかどうかを覚えておく、テスト用の接続 */
  const createClosableConnection = (): DrawSocket & { closedWith: number[] } => {
    const closedWith: number[] = []
    return { closedWith, send: () => {}, close: (code) => closedWith.push(code ?? 0) }
  }

  it('POST /revoke を受けたら、見るだけの接続（オーバーレイ用キーで開かれたもの）だけを閉じる', async () => {
    const drawScreen = createClosableConnection()
    const stagePage = createClosableConnection()
    const channel = new DrawChannel(createStorage([
      [drawScreen, WRITER],
      [stagePage, VIEWER],
    ]))

    const response = await channel.fetch(new Request('https://draw-channel/revoke', { method: 'POST', body: JSON.stringify({ keyTag: 'tag-new' }) }))

    expect(response.status).toBe(204)
    expect(stagePage.closedWith).toEqual([4001])
    // 描く画面は配信者のセッションで開かれているので、キーの再発行とは関係なく残す
    expect(drawScreen.closedWith).toEqual([])
  })

  it('覚えている目印と違うキーで見るだけの接続を開こうとしたら、受け入れずに401を返す', async () => {
    const storage = createStorage([])
    const channel = new DrawChannel(storage)
    await channel.fetch(new Request('https://draw-channel/revoke', { method: 'POST', body: JSON.stringify({ keyTag: 'tag-new' }) }))

    const response = await channel.fetch(new Request('https://draw-channel/api/overlay/caption?role=viewer&keyTag=tag-old', { headers: { Upgrade: 'websocket' } }))

    expect(response.status).toBe(401)
    expect(storage.acceptedRoles).toEqual([])
  })

  it('接続の引き渡しでは、見るだけの接続に Worker の確かめた目印を付け、利用者の送ってきた目印は捨てる', async () => {
    const relay = createFakeDrawChannel()
    const forged = new Request('https://hdad.example.com/api/overlay/draw?key=k&keyTag=forged&role=writer', { headers: { Upgrade: 'websocket' } })

    await connectDrawSocket(relay.namespace, forged, { role: 'viewer', keyTag: 'tag-of-key' })

    const forwarded = relay.forwardedConnections.map((request) => new URL(request.url).searchParams)
    expect(forwarded.map((params) => params.getAll('keyTag'))).toEqual([['tag-of-key']])
    expect(forwarded.map((params) => params.getAll('role'))).toEqual([['viewer']])
  })

  it('revokeRelayViewers は指定した中継先（手書き・字幕）へ、新しいキーの目印を付けて切断を頼む', async () => {
    const relay = createFakeDrawChannel()

    await revokeRelayViewers(relay.namespace, 'draw', 'tag-new')
    await revokeRelayViewers(relay.namespace, 'caption', 'tag-new')

    expect(relay.revocations).toEqual([
      { channel: 'draw', keyTag: 'tag-new' },
      { channel: 'caption', keyTag: 'tag-new' },
    ])
    expect(relay.forwardedConnections).toEqual([])
  })
})
