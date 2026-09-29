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
const 接続を作る = (): CommentSocket & { 送られたもの: string[] } => {
  const 送られたもの: string[] = []
  return { 送られたもの, send: (message) => 送られたもの.push(message), close: () => {} }
}

/** 接続と保管先を持つ、テスト用の保持の仕組み */
const 保持の仕組みを作る = (接続たち: readonly CommentSocket[]): CommentChannelState => {
  const 保管 = new Map<string, unknown>()
  return {
    acceptWebSocket: () => {},
    getWebSockets: () => [...接続たち],
    setWebSocketAutoResponse: () => {},
    storage: {
      get: async <T>(key: string) => 保管.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        保管.set(key, value)
      },
    },
  }
}

/** Worker が押し出すのと同じ形のリクエストを作る */
const 押し出す = (channel: CommentChannel, 本文: string): Promise<Response> =>
  channel.fetch(new Request('https://comment-channel/push', { method: 'POST', body: 本文 }))

describe('CommentChannel', () => {
  it('押し出された1件を、開いている画面すべてへ配る', async () => {
    const 配信者のPC = 接続を作る()
    const 配信者のスマホ = 接続を作る()
    const channel = new CommentChannel(保持の仕組みを作る([配信者のPC, 配信者のスマホ]))

    const 応答 = await 押し出す(channel, '{"kind":"follow","id":"フォローの通知"}')

    expect(応答.status).toBe(204)
    const 届いたもの = '{"type":"item","item":{"kind":"follow","id":"フォローの通知"}}'
    expect(配信者のPC.送られたもの).toEqual([届いたもの])
    expect(配信者のスマホ.送られたもの).toEqual([届いたもの])
  })

  it('押し出された1件を覚えておき、画面を開き直したときの履歴として古い順に返す', async () => {
    const channel = new CommentChannel(保持の仕組みを作る([]))

    await 押し出す(channel, '{"id":"1件目"}')
    await 押し出す(channel, '{"id":"2件目"}')

    expect(await channel.backlog()).toBe('{"type":"backlog","items":[{"id":"1件目"},{"id":"2件目"}]}')
  })

  it('覚えておくのは直近の上限の件数までで、古いものから忘れる', async () => {
    const channel = new CommentChannel(保持の仕組みを作る([]))

    for (let 番号 = 0; 番号 < RECENT_LIMIT + 1; 番号 += 1) await 押し出す(channel, `{"id":"${番号}件目"}`)

    const 履歴 = JSON.parse(await channel.backlog()) as { items: { id: string }[] }
    expect(履歴.items).toHaveLength(RECENT_LIMIT)
    expect(履歴.items[0]?.id).toBe('1件目')
    expect(履歴.items.at(-1)?.id).toBe(`${RECENT_LIMIT}件目`)
  })

  it('まだ何も押し出されていなければ、空の履歴を返す', async () => {
    const channel = new CommentChannel(保持の仕組みを作る([]))

    expect(await channel.backlog()).toBe('{"type":"backlog","items":[]}')
  })

  it('押し出し以外の経路は404を返す', async () => {
    const channel = new CommentChannel(保持の仕組みを作る([]))

    const 応答 = await channel.fetch(new Request('https://comment-channel/どこか'))

    expect(応答.status).toBe(404)
  })
})
