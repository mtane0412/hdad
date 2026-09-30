/**
 * 手書きの線の中継（Durable Object）のテスト
 *
 * WebSocketの接続そのもの（Upgrade）は Cloudflare のランタイムでしか作れないため、ここでは確かめない。
 * 確かめるのは、描く画面から届いた線を他の接続へ配ること、送り主自身へは返さないこと、
 * そして合成ページ（見るだけの接続）から送られてきたものは配らないことである。
 */
import { describe, expect, it } from 'vitest'
import { DrawChannel, WRITER, VIEWER, type DrawSocket, type DrawChannelState } from './draw-channel'

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
