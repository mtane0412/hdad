/**
 * 手書きの線の中継（Durable Object）のテスト
 *
 * WebSocketの接続そのもの（Upgrade）は Cloudflare のランタイムでしか作れないため、ここでは確かめない。
 * 確かめるのは、描く画面から届いた線を他の接続へ配ること、送り主自身へは返さないこと、
 * そして合成ページ（見るだけの接続）から送られてきたものは配らないことである。
 */
import { describe, expect, it } from 'vitest'
import { DrawChannel, WRITER, VIEWER, type DrawSocket, type DrawChannelState } from './draw-channel'
import { createFakeBackgroundStorage } from './fake-background-storage'

/** 送られた文字列を覚えておく、テスト用の接続 */
const 接続を作る = (): DrawSocket & { 送られたもの: string[] } => {
  const 送られたもの: string[] = []
  return { 送られたもの, send: (message) => 送られたもの.push(message), close: () => {} }
}

/** 接続とその役割を覚えておく、テスト用の保持の仕組み */
const 保持の仕組みを作る = (
  接続たち: readonly (readonly [DrawSocket, string])[] = [],
): DrawChannelState & { 受け入れた役割: string[][] } => {
  const 受け入れた役割: string[][] = []
  return {
    受け入れた役割,
    acceptWebSocket: (_socket, tags) => 受け入れた役割.push([...(tags ?? [])]),
    getWebSockets: () => 接続たち.map(([socket]) => socket),
    getTags: (socket) => 接続たち.find(([候補]) => 候補 === socket)?.[1].split(',') ?? [],
    setWebSocketAutoResponse: () => {},
    storage: createFakeBackgroundStorage(),
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

describe('DrawChannel の背景（配信画面を撮った最新の1枚）', () => {
  const 撮った時刻 = Date.parse('2026-09-29T12:00:00Z')

  const 背景を置く = (channel: DrawChannel, 撮った: number = 撮った時刻) =>
    channel.fetch(
      new Request('https://draw/background', {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png', 'X-Captured-At': String(撮った) },
        body: new Uint8Array([1, 2, 3]),
      }),
    )

  it('置いた1枚を、形式・撮った時刻・印（ETag）付きで返す', async () => {
    const channel = new DrawChannel(保持の仕組みを作る())
    await 背景を置く(channel)

    const 応答 = await channel.fetch(new Request('https://draw/background'))

    expect(応答.status).toBe(200)
    expect(応答.headers.get('Content-Type')).toBe('image/png')
    expect(応答.headers.get('X-Captured-At')).toBe(String(撮った時刻))
    expect(応答.headers.get('ETag')).toBe(`"${撮った時刻}"`)
    expect(new Uint8Array(await 応答.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('手元と同じ印を添えて読みに来たら、画像を送らず304を返す', async () => {
    const channel = new DrawChannel(保持の仕組みを作る())
    await 背景を置く(channel)

    const 応答 = await channel.fetch(new Request('https://draw/background', { headers: { 'If-None-Match': `"${撮った時刻}"` } }))

    expect(応答.status).toBe(304)
  })

  it('新しい1枚に置き換わっていれば、古い印を添えて読みに来ても画像を返す', async () => {
    const channel = new DrawChannel(保持の仕組みを作る())
    await 背景を置く(channel)
    await 背景を置く(channel, 撮った時刻 + 60_000)

    const 応答 = await channel.fetch(new Request('https://draw/background', { headers: { 'If-None-Match': `"${撮った時刻}"` } }))

    expect(応答.status).toBe(200)
    expect(応答.headers.get('X-Captured-At')).toBe(String(撮った時刻 + 60_000))
  })

  it('まだ1枚も置いていなければ204を返す', async () => {
    const channel = new DrawChannel(保持の仕組みを作る())

    const 応答 = await channel.fetch(new Request('https://draw/background'))

    expect(応答.status).toBe(204)
  })

  it('撮った時刻の無い1枚は置かない', async () => {
    const channel = new DrawChannel(保持の仕組みを作る())

    const 応答 = await channel.fetch(new Request('https://draw/background', { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array([1]) }))

    expect(応答.status).toBe(400)
  })

  it('WebSocketでも背景でもない呼び出しは404を返す', async () => {
    const channel = new DrawChannel(保持の仕組みを作る())

    const 応答 = await channel.fetch(new Request('https://draw/other'))

    expect(応答.status).toBe(404)
  })
})
