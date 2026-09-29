/**
 * アラートの配送（Durable Object）のテスト
 *
 * WebSocketの接続そのもの（Upgrade）は Cloudflare のランタイムでしか作れないため、ここでは確かめない。
 * 確かめるのは、押し出されたアラートを開いている接続へ配ること、そして Worker 側から押し出す入口（pushAlert）が
 * 失敗を握りつぶさないことである（配る部分そのものは worker/socket-broadcast.test.ts が確かめる）。
 */
import { describe, expect, it } from 'vitest'
import { AlertChannel, pushAlert, type AlertSocket } from './alert-channel'
import { createFakeAlertChannel } from './fake-alert-channel'
import type { OverlayAlert } from './alert-event'

const アラート: OverlayAlert = {
  media: { kind: 'image', url: '/api/media/media-1?key=オーバーレイ用キー' },
  durationSeconds: 5,
  volume: 0.5,
  text: 'ありがとう！',
}

/** 送られた文字列を覚えておく、テスト用の接続 */
const 接続を作る = (): AlertSocket & { 送られたもの: string[] } => {
  const 送られたもの: string[] = []
  return { 送られたもの, send: (message) => 送られたもの.push(message), close: () => undefined }
}

describe('AlertChannel', () => {
  /** 開いている接続を差し替えられる、テスト用の Durable Object を作る */
  const 配送先を作る = (sockets: AlertSocket[]): AlertChannel =>
    new AlertChannel({
      acceptWebSocket: () => undefined,
      getWebSockets: () => sockets,
      setWebSocketAutoResponse: () => undefined,
    })

  it('押し出されたアラートを、開いている接続すべてへJSONで送る', async () => {
    const 接続 = 接続を作る()
    const 配送先 = 配送先を作る([接続])

    const response = await 配送先.fetch(new Request('https://alert-channel/push', { method: 'POST', body: JSON.stringify(アラート) }))

    expect(response.status).toBe(204)
    expect(接続.送られたもの).toEqual([JSON.stringify(アラート)])
  })

  it('接続が1本もなければ、送らずに終わる（オーバーレイを開いていない間のアラートは落とす）', async () => {
    const 配送先 = 配送先を作る([])

    const response = await 配送先.fetch(new Request('https://alert-channel/push', { method: 'POST', body: JSON.stringify(アラート) }))

    expect(response.status).toBe(204)
  })

  it('知らない経路は404で返す', async () => {
    const 配送先 = 配送先を作る([])

    const response = await 配送先.fetch(new Request('https://alert-channel/知らない経路', { method: 'POST' }))

    expect(response.status).toBe(404)
  })
})

describe('pushAlert', () => {
  it('Durable Object へアラートを送る', async () => {
    const 配送 = createFakeAlertChannel()

    await pushAlert(配送.namespace, アラート)

    expect(配送.押し出されたアラート).toEqual([アラート])
  })

  it('Durable Object が失敗を返したら、黙って成功にせず投げる', async () => {
    const 配送 = createFakeAlertChannel({ 失敗する: true })

    await expect(pushAlert(配送.namespace, アラート)).rejects.toThrow('アラート')
  })
})
