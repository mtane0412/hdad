/**
 * アラートの配送（Durable Object）のテスト
 *
 * WebSocketの接続そのもの（Upgrade）は Cloudflare のランタイムでしか作れないため、ここでは確かめない。
 * 確かめるのは、押し出されたアラートを開いている接続へ配ること、そして Worker 側から押し出す入口（pushAlert）が
 * 失敗を握りつぶさないことである（配る部分そのものは worker/socket-broadcast.test.ts が確かめる）。
 */
import { describe, expect, it } from 'vitest'
import { AlertChannel, connectAlertSocket, connectBgmSocket, pushAlert, pushBgm, revokeAlertSockets, type AlertSocket } from './alert-channel'
import type { BgmNowPlaying } from './bgm-config'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeDurableStorage } from './fake-durable-storage'
import type { OverlayAlert } from './alert-event'

const alert: OverlayAlert = {
  media: { kind: 'image', url: '/api/media/media-1?key=オーバーレイ用キー' },
  durationSeconds: 5,
  volume: 0.5,
  text: 'ありがとう！',
}

/** 雑談のBGMを流しているときに配るもの */
const playingTrack: BgmNowPlaying = {
  track: {
    mediaId: 'media-zatsudan',
    title: 'ひだまりの午後',
    credit: '音楽: 甘茶の音楽工房',
    creditUrl: 'https://amachamusic.chagasi.com/',
    url: '/api/media/media-zatsudan?key=オーバーレイ用キー',
  },
  volume: 0.3,  repeat: false,
  shuffle: false,
}

/** 送られた文字列を覚えておく、テスト用の接続 */
const createConnection = (): AlertSocket & { sentMessages: string[] } => {
  const sentMessages: string[] = []
  return { sentMessages, send: (message) => sentMessages.push(message), close: () => undefined }
}

describe('AlertChannel', () => {
  /**
   * 開いている接続を差し替えられる、テスト用の Durable Object を作る。
   *
   * 接続は目印（アラート用か BGM 用か）ごとに渡す。目印を指定して引いたときは、その目印の接続だけを返す
   * （Cloudflare の getWebSockets(tag) と同じ振る舞い）。
   */
  const createDestination = (sockets: AlertSocket[], bgmSockets: AlertSocket[] = []): AlertChannel =>
    new AlertChannel({
      acceptWebSocket: () => undefined,
      getWebSockets: (tag) => (tag === 'bgm' ? bgmSockets : tag === 'alerts' ? sockets : [...sockets, ...bgmSockets]),
      setWebSocketAutoResponse: () => undefined,
      storage: createFakeDurableStorage(),
    })

  it('押し出されたアラートを、開いている接続すべてへJSONで送る', async () => {
    const connection = createConnection()
    const destination = createDestination([connection])

    const response = await destination.fetch(new Request('https://alert-channel/push', { method: 'POST', body: JSON.stringify(alert) }))

    expect(response.status).toBe(204)
    expect(connection.sentMessages).toEqual([JSON.stringify(alert)])
  })

  it('アラートは、BGMを受け取る接続（裏方のページ）へは送らない', async () => {
    const stagePage = createConnection()
    const backstagePage = createConnection()
    const destination = createDestination([stagePage], [backstagePage])

    await destination.fetch(new Request('https://alert-channel/push', { method: 'POST', body: JSON.stringify(alert) }))

    expect(stagePage.sentMessages).toEqual([JSON.stringify(alert)])
    expect(backstagePage.sentMessages).toEqual([])
  })

  it('BGMの切り替えは、BGMを受け取る接続だけへ送る（合成ページはアラートとして読めないため）', async () => {
    const stagePage = createConnection()
    const backstagePage = createConnection()
    const destination = createDestination([stagePage], [backstagePage])

    const response = await destination.fetch(new Request('https://alert-channel/push/bgm', { method: 'POST', body: JSON.stringify(playingTrack) }))

    expect(response.status).toBe(204)
    expect(backstagePage.sentMessages).toEqual([JSON.stringify(playingTrack)])
    expect(stagePage.sentMessages).toEqual([])
  })

  it('接続が1本もなければ、送らずに終わる（オーバーレイを開いていない間のアラートは落とす）', async () => {
    const destination = createDestination([])

    const response = await destination.fetch(new Request('https://alert-channel/push', { method: 'POST', body: JSON.stringify(alert) }))

    expect(response.status).toBe(204)
  })

  it('知らない経路は404で返す', async () => {
    const destination = createDestination([])

    const response = await destination.fetch(new Request('https://alert-channel/知らない経路', { method: 'POST' }))

    expect(response.status).toBe(404)
  })
})

describe('pushAlert', () => {
  it('Durable Object へアラートを送る', async () => {
    const delivery = createFakeAlertChannel()

    await pushAlert(delivery.namespace, alert)

    expect(delivery.pushedAlerts).toEqual([alert])
  })

  it('Durable Object が失敗を返したら、黙って成功にせず投げる', async () => {
    const delivery = createFakeAlertChannel({ shouldFail: true })

    await expect(pushAlert(delivery.namespace, alert)).rejects.toThrow('アラート')
  })
})

describe('接続の引き渡し', () => {
  it('アラートの接続と BGM の接続を、目印を付けて Durable Object へ引き渡す', async () => {
    const delivery = createFakeAlertChannel()
    const connectionRequest = (): Request => new Request('https://hdad.example.com/api/overlay/socket?key=k', { headers: { Upgrade: 'websocket' } })

    await connectAlertSocket(delivery.namespace, connectionRequest(), 'tag-of-key')
    await connectBgmSocket(delivery.namespace, connectionRequest(), 'tag-of-key')

    expect(delivery.forwardedConnections.map((request) => new URL(request.url).searchParams.get('topic'))).toEqual(['alerts', 'bgm'])
  })
})

describe('pushBgm', () => {
  it('Durable Object へ、いま流している曲を送る', async () => {
    const delivery = createFakeAlertChannel()

    await pushBgm(delivery.namespace, playingTrack)

    expect(delivery.pushedBgm).toEqual([playingTrack])
    expect(delivery.pushedAlerts).toEqual([])
  })

  it('Durable Object が失敗を返したら、黙って成功にせず投げる', async () => {
    const delivery = createFakeAlertChannel({ shouldFail: true })

    await expect(pushBgm(delivery.namespace, playingTrack)).rejects.toThrow('BGM')
  })
})

describe('オーバーレイ用キーの再発行に伴う切断', () => {
  /** 閉じられたかどうかを覚えておく、テスト用の接続 */
  const createClosableConnection = (): AlertSocket & { closedWith: number[] } => {
    const closedWith: number[] = []
    return { closedWith, send: () => undefined, close: (code) => closedWith.push(code ?? 0) }
  }

  it('POST /revoke を受けたら、新しいキーの目印を覚え、アラートの接続も BGM の接続もすべて閉じる', async () => {
    const stagePage = createClosableConnection()
    const backstagePage = createClosableConnection()
    const storage = createFakeDurableStorage()
    const destination = new AlertChannel({
      acceptWebSocket: () => undefined,
      getWebSockets: (tag) => (tag === 'bgm' ? [backstagePage] : tag === 'alerts' ? [stagePage] : [stagePage, backstagePage]),
      setWebSocketAutoResponse: () => undefined,
      storage,
    })

    const response = await destination.fetch(new Request('https://alert-channel/revoke', { method: 'POST', body: JSON.stringify({ keyTag: 'tag-new' }) }))

    expect(response.status).toBe(204)
    expect(stagePage.closedWith).toEqual([4001])
    expect(backstagePage.closedWith).toEqual([4001])
    expect([...storage.values.values()]).toEqual(['tag-new'])
  })

  it('POST /revoke に新しいキーの目印がなければ400を返し、何も閉じない', async () => {
    const stagePage = createClosableConnection()
    const destination = new AlertChannel({
      acceptWebSocket: () => undefined,
      getWebSockets: () => [stagePage],
      setWebSocketAutoResponse: () => undefined,
      storage: createFakeDurableStorage(),
    })

    const response = await destination.fetch(new Request('https://alert-channel/revoke', { method: 'POST', body: '{}' }))

    expect(response.status).toBe(400)
    expect(stagePage.closedWith).toEqual([])
  })

  it('覚えている目印と違うキーで開こうとした接続は、受け入れずに401を返す（KVの反映待ちで古いキーが通ってしまっても弾く）', async () => {
    const accepted: string[][] = []
    const storage = createFakeDurableStorage()
    const destination = new AlertChannel({
      acceptWebSocket: (_socket, tags) => accepted.push(tags ?? []),
      getWebSockets: () => [],
      setWebSocketAutoResponse: () => undefined,
      storage,
    })
    await destination.fetch(new Request('https://alert-channel/revoke', { method: 'POST', body: JSON.stringify({ keyTag: 'tag-new' }) }))

    const response = await destination.fetch(new Request('https://alert-channel/api/overlay/socket?topic=alerts&keyTag=tag-old', { headers: { Upgrade: 'websocket' } }))

    expect(response.status).toBe(401)
    expect(accepted).toEqual([])
  })

  it('接続の引き渡しでは、利用者が送ってきた目印を Worker の確かめた目印で上書きする', async () => {
    const delivery = createFakeAlertChannel()
    const forged = new Request('https://hdad.example.com/api/overlay/socket?key=k&keyTag=forged', { headers: { Upgrade: 'websocket' } })

    await connectAlertSocket(delivery.namespace, forged, 'tag-of-key')

    expect(delivery.forwardedConnections.map((request) => new URL(request.url).searchParams.getAll('keyTag'))).toEqual([['tag-of-key']])
  })

  it('revokeAlertSockets は新しいキーの目印を付けて切断を頼み、失敗を返されたら投げる', async () => {
    const delivery = createFakeAlertChannel()
    await revokeAlertSockets(delivery.namespace, 'tag-new')
    expect(delivery.revokedKeyTags).toEqual(['tag-new'])
    expect(delivery.pushedAlerts).toEqual([])

    await expect(revokeAlertSockets(createFakeAlertChannel({ shouldFail: true }).namespace, 'tag-new')).rejects.toThrow('切断')
  })
})
