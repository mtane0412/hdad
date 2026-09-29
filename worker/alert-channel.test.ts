/**
 * アラートの配送（Durable Object）のテスト
 *
 * WebSocketの接続そのもの（Upgrade）は Cloudflare のランタイムでしか作れないため、ここでは確かめない。
 * 確かめるのは、押し出されたアラートを開いている接続へ配ること、そして Worker 側から押し出す入口（pushAlert）が
 * 失敗を握りつぶさないことである（配る部分そのものは worker/socket-broadcast.test.ts が確かめる）。
 */
import { describe, expect, it } from 'vitest'
import { AlertChannel, connectAlertSocket, connectBgmSocket, pushAlert, pushBgm, type AlertSocket } from './alert-channel'
import type { BgmNowPlaying } from './bgm-config'
import { createFakeAlertChannel } from './fake-alert-channel'
import type { OverlayAlert } from './alert-event'

const アラート: OverlayAlert = {
  media: { kind: 'image', url: '/api/media/media-1?key=オーバーレイ用キー' },
  durationSeconds: 5,
  volume: 0.5,
  text: 'ありがとう！',
}

/** 雑談のBGMを流しているときに配るもの */
const 再生中の曲: BgmNowPlaying = {
  track: {
    mediaId: 'media-zatsudan',
    title: 'ひだまりの午後',
    credit: '音楽: 甘茶の音楽工房',
    creditUrl: 'https://amachamusic.chagasi.com/',
    url: '/api/media/media-zatsudan?key=オーバーレイ用キー',
  },
  volume: 0.3,
}

/** 送られた文字列を覚えておく、テスト用の接続 */
const 接続を作る = (): AlertSocket & { 送られたもの: string[] } => {
  const 送られたもの: string[] = []
  return { 送られたもの, send: (message) => 送られたもの.push(message), close: () => undefined }
}

describe('AlertChannel', () => {
  /**
   * 開いている接続を差し替えられる、テスト用の Durable Object を作る。
   *
   * 接続は目印（アラート用か BGM 用か）ごとに渡す。目印を指定して引いたときは、その目印の接続だけを返す
   * （Cloudflare の getWebSockets(tag) と同じ振る舞い）。
   */
  const 配送先を作る = (sockets: AlertSocket[], bgmSockets: AlertSocket[] = []): AlertChannel =>
    new AlertChannel({
      acceptWebSocket: () => undefined,
      getWebSockets: (tag) => (tag === 'bgm' ? bgmSockets : tag === 'alerts' ? sockets : [...sockets, ...bgmSockets]),
      setWebSocketAutoResponse: () => undefined,
    })

  it('押し出されたアラートを、開いている接続すべてへJSONで送る', async () => {
    const 接続 = 接続を作る()
    const 配送先 = 配送先を作る([接続])

    const response = await 配送先.fetch(new Request('https://alert-channel/push', { method: 'POST', body: JSON.stringify(アラート) }))

    expect(response.status).toBe(204)
    expect(接続.送られたもの).toEqual([JSON.stringify(アラート)])
  })

  it('アラートは、BGMを受け取る接続（裏方のページ）へは送らない', async () => {
    const 合成ページ = 接続を作る()
    const 裏方のページ = 接続を作る()
    const 配送先 = 配送先を作る([合成ページ], [裏方のページ])

    await 配送先.fetch(new Request('https://alert-channel/push', { method: 'POST', body: JSON.stringify(アラート) }))

    expect(合成ページ.送られたもの).toEqual([JSON.stringify(アラート)])
    expect(裏方のページ.送られたもの).toEqual([])
  })

  it('BGMの切り替えは、BGMを受け取る接続だけへ送る（合成ページはアラートとして読めないため）', async () => {
    const 合成ページ = 接続を作る()
    const 裏方のページ = 接続を作る()
    const 配送先 = 配送先を作る([合成ページ], [裏方のページ])

    const response = await 配送先.fetch(new Request('https://alert-channel/push/bgm', { method: 'POST', body: JSON.stringify(再生中の曲) }))

    expect(response.status).toBe(204)
    expect(裏方のページ.送られたもの).toEqual([JSON.stringify(再生中の曲)])
    expect(合成ページ.送られたもの).toEqual([])
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

describe('接続の引き渡し', () => {
  it('アラートの接続と BGM の接続を、目印を付けて Durable Object へ引き渡す', async () => {
    const 配送 = createFakeAlertChannel()
    const 接続の要求 = (): Request => new Request('https://hdad.example.com/api/overlay/socket?key=k', { headers: { Upgrade: 'websocket' } })

    await connectAlertSocket(配送.namespace, 接続の要求())
    await connectBgmSocket(配送.namespace, 接続の要求())

    expect(配送.引き渡された接続.map((request) => new URL(request.url).searchParams.get('topic'))).toEqual(['alerts', 'bgm'])
  })
})

describe('pushBgm', () => {
  it('Durable Object へ、いま流している曲を送る', async () => {
    const 配送 = createFakeAlertChannel()

    await pushBgm(配送.namespace, 再生中の曲)

    expect(配送.押し出されたBGM).toEqual([再生中の曲])
    expect(配送.押し出されたアラート).toEqual([])
  })

  it('Durable Object が失敗を返したら、黙って成功にせず投げる', async () => {
    const 配送 = createFakeAlertChannel({ 失敗する: true })

    await expect(pushBgm(配送.namespace, 再生中の曲)).rejects.toThrow('BGM')
  })
})
