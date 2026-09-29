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
const 接続を作る = (): DrawSocket & { 送られたもの: string[] } => {
  const 送られたもの: string[] = []
  return { 送られたもの, send: (message) => 送られたもの.push(message), close: () => {} }
}

/** 接続とその役割を覚えておく、テスト用の保持の仕組み */
const 保持の仕組みを作る = (
  接続たち: readonly (readonly [DrawSocket, string])[],
): DrawChannelState & { 受け入れた役割: string[][] } => {
  const 受け入れた役割: string[][] = []
  return {
    受け入れた役割,
    acceptWebSocket: (_socket, tags) => 受け入れた役割.push([...(tags ?? [])]),
    getWebSockets: () => 接続たち.map(([socket]) => socket),
    getTags: (socket) => 接続たち.find(([候補]) => 候補 === socket)?.[1].split(',') ?? [],
    setWebSocketAutoResponse: () => {},
  }
}

describe('DrawChannel', () => {
  it('描く画面から届いた線を、他の接続へ配る', () => {
    const 描く画面 = 接続を作る()
    const 合成ページ = 接続を作る()
    const channel = new DrawChannel(保持の仕組みを作る([
      [描く画面, WRITER],
      [合成ページ, VIEWER],
    ]))

    channel.webSocketMessage(描く画面, '{"type":"start","id":"線1","point":{"x":0.1,"y":0.2}}')

    expect(合成ページ.送られたもの).toEqual(['{"type":"start","id":"線1","point":{"x":0.1,"y":0.2}}'])
  })

  it('送り主自身へは返さない', () => {
    // 描く画面は自分のキャンバスへ直接描いているので、返すと同じ線を二重に持つことになる
    const 描く画面 = 接続を作る()
    const channel = new DrawChannel(保持の仕組みを作る([[描く画面, WRITER]]))

    channel.webSocketMessage(描く画面, '{"type":"start","id":"線1","point":{"x":0.1,"y":0.2}}')

    expect(描く画面.送られたもの).toEqual([])
  })

  it('見るだけの接続から送られてきたものは配らない', () => {
    // オーバーレイ用キーは配信画面に映りうるので、それを持つだけでは他人の画面に描けないようにする
    const 合成ページ = 接続を作る()
    const もう1つの合成ページ = 接続を作る()
    const channel = new DrawChannel(保持の仕組みを作る([
      [合成ページ, VIEWER],
      [もう1つの合成ページ, VIEWER],
    ]))

    channel.webSocketMessage(合成ページ, '{"type":"start","id":"線1","point":{"x":0.1,"y":0.2}}')

    expect(もう1つの合成ページ.送られたもの).toEqual([])
  })

  it('文字列でないものは配らない', () => {
    // 描く画面は文字列しか送らない。それ以外が届いたら、送り手の作りを疑う
    const 描く画面 = 接続を作る()
    const 合成ページ = 接続を作る()
    const channel = new DrawChannel(保持の仕組みを作る([
      [描く画面, WRITER],
      [合成ページ, VIEWER],
    ]))

    channel.webSocketMessage(描く画面, new ArrayBuffer(8))

    expect(合成ページ.送られたもの).toEqual([])
  })
})
