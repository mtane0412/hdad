/**
 * コメントビューアーへの配送（Durable Object）のテスト
 *
 * WebSocketの接続そのもの（Upgrade）は Cloudflare のランタイムでしか作れないため、ここでは確かめない。
 * 確かめるのは、Worker が押し出した1件を開いている画面すべてへ配ること、直近の1件を上限まで覚えておき、
 * 画面を開き直したときに渡す履歴として返せることである。
 */
import { describe, expect, it } from 'vitest'
import { CommentChannel, RECENT_LIMIT, type CommentChannelState, type CommentSocket } from './comment-channel'

/** 送られた文字列を覚えておく、テスト用の接続 */
const createConnection = (): CommentSocket & { received: string[] } => {
  const received: string[] = []
  return { received, send: (message) => received.push(message), close: () => {} }
}

/** 接続と保管先を持つ、テスト用の保持の仕組み */
const createStorage = (connections: readonly CommentSocket[]): CommentChannelState => {
  const storage = new Map<string, unknown>()
  return {
    acceptWebSocket: () => {},
    getWebSockets: () => [...connections],
    setWebSocketAutoResponse: () => {},
    storage: {
      get: async <T>(key: string) => storage.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
    },
  }
}

/** Worker が押し出すのと同じ形のリクエストを作る */
const pushOut = (channel: CommentChannel, text: string): Promise<Response> =>
  channel.fetch(new Request('https://comment-channel/push', { method: 'POST', body: text }))

describe('CommentChannel', () => {
  it('押し出された1件を、開いている画面すべてへ配る', async () => {
    const broadcasterPc = createConnection()
    const broadcasterPhone = createConnection()
    const channel = new CommentChannel(createStorage([broadcasterPc, broadcasterPhone]))

    const response = await pushOut(channel, '{"kind":"follow","id":"フォローの通知"}')

    expect(response.status).toBe(204)
    const delivered = '{"type":"item","item":{"kind":"follow","id":"フォローの通知"}}'
    expect(broadcasterPc.received).toEqual([delivered])
    expect(broadcasterPhone.received).toEqual([delivered])
  })

  it('押し出された1件を覚えておき、画面を開き直したときの履歴として古い順に返す', async () => {
    const channel = new CommentChannel(createStorage([]))

    await pushOut(channel, '{"id":"1件目"}')
    await pushOut(channel, '{"id":"2件目"}')

    expect(await channel.backlog()).toBe('{"type":"backlog","items":[{"id":"1件目"},{"id":"2件目"}]}')
  })

  it('覚えておくのは直近の上限の件数までで、古いものから忘れる', async () => {
    const channel = new CommentChannel(createStorage([]))

    for (let index = 0; index < RECENT_LIMIT + 1; index += 1) await pushOut(channel, `{"id":"${index}件目"}`)

    const history = JSON.parse(await channel.backlog()) as { items: { id: string }[] }
    expect(history.items).toHaveLength(RECENT_LIMIT)
    expect(history.items[0]?.id).toBe('1件目')
    expect(history.items.at(-1)?.id).toBe(`${RECENT_LIMIT}件目`)
  })

  it('まだ何も押し出されていなければ、空の履歴を返す', async () => {
    const channel = new CommentChannel(createStorage([]))

    expect(await channel.backlog()).toBe('{"type":"backlog","items":[]}')
  })

  it('押し出し以外の経路は404を返す', async () => {
    const channel = new CommentChannel(createStorage([]))

    const response = await channel.fetch(new Request('https://comment-channel/どこか'))

    expect(response.status).toBe(404)
  })
})
