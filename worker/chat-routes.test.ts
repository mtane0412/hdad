/**
 * チャットボックス向けの公開API（/api/chat/*）のテスト
 *
 * OBSのブラウザソース（chat/<id>/）から、キーもセッションも無しで呼ばれる経路。
 * Twitchへの通信を差し替え、「正しく中継するか」「同じ問い合わせを繰り返さないか（KVに貯める）」
 * 「おかしな指定を早めに断るか」を確かめる。
 */
import { describe, expect, it } from 'vitest'
import { createFakeBucket } from './fake-bucket'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeDatabase } from './fake-database'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeStore } from './fake-store'
import { handleRequest, type Env } from './index'

const now = Date.parse('2026-09-21T12:10:00Z')
const broadcasterId = '12345'
const site = 'https://hdad.example.com'

const createEnv = () => {
  const store = createFakeStore()
  const env = {
    STORE: store,
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: broadcasterId,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: createFakeAlertChannel().namespace,
    DRAW: createFakeDrawChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    AI: createFakeWorkersAi(),
  } satisfies Env
  return { env, store }
}

/** グローバルの「配信者」バッジと、チャンネル固有の「サブスク」バッジ */
const globalBadges = {
  set_id: 'broadcaster',
  versions: [{ id: '1', image_url_2x: 'https://example.test/badges/broadcaster/2', title: 'Broadcaster' }],
}
const channelBadges = {
  set_id: 'subscriber',
  versions: [{ id: '12', image_url_2x: 'https://example.test/badges/subscriber-12/2', title: '1-Year Subscriber' }],
}
const cheermote = {
  prefix: 'Cheer',
  tiers: [{ min_bits: 1, color: '#979797', images: { dark: { animated: { '2': 'https://example.test/cheer/1.gif' } } } }],
}

/** Twitchの応答を、呼ばれたURLごとに決めて返す fetch。送られたURLも記録する */
const fakeTwitch = () => {
  const urls: string[] = []
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    urls.push(url.origin + url.pathname + url.search)
    if (url.pathname === '/oauth2/token') return Response.json({ access_token: 'test-app-token', expires_in: 5000 })
    if (url.pathname === '/helix/chat/badges/global') return Response.json({ data: [globalBadges] })
    if (url.pathname === '/helix/chat/badges') return Response.json({ data: [channelBadges] })
    if (url.pathname === '/helix/bits/cheermotes') return Response.json({ data: [cheermote] })
    if (url.pathname === '/helix/users') return Response.json({ data: [{ id: broadcasterId, login: 'tanenob' }] })
    throw new Error(`テストで想定していない通信です: ${url.toString()}`)
  }
  return { urls, fetchImpl }
}

/** アナウンスの送信間隔を空けるための待ちは、テストでは実際に待たない */
const noWait = async (): Promise<void> => {}

/**
 * これらの経路は応答のあとに続く処理（waitUntil）を使わない。
 * 黙って捨てると気づけなくなるので、預けられたら失敗させる（使うのは webhook-routes.test.ts だけ）。
 */
const noDefer = (): void => {
  throw new Error('このテストでは、応答のあとに続く処理を使いません')
}

const fetchIt = (env: Env, path: string, fetchImpl: typeof fetch): Promise<Response> =>
  handleRequest(new Request(`${site}${path}`, { headers: { Origin: site } }), env, { fetch: fetchImpl, now: () => now, wait: noWait, waitUntil: noDefer })

describe('GET /api/chat/badges', () => {
  it('全体のバッジとチャンネル固有のバッジをまとめて返す（ログインもキーも要らない）', async () => {
    const { env } = createEnv()
    const { fetchImpl } = fakeTwitch()
    const response = await fetchIt(env, '/api/chat/badges', fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      badges: [
        { setId: 'broadcaster', versions: [{ id: '1', imageUrl: 'https://example.test/badges/broadcaster/2', title: 'Broadcaster' }] },
        { setId: 'subscriber', versions: [{ id: '12', imageUrl: 'https://example.test/badges/subscriber-12/2', title: '1-Year Subscriber' }] },
      ],
    })
  })

  it('チャンネル固有のバッジが、同じ種類の全体のバッジを上書きする（チャンネルのサブスクバッジを優先する）', async () => {
    const { env } = createEnv()
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname === '/oauth2/token') return Response.json({ access_token: 'test-app-token', expires_in: 5000 })
      // 全体にもチャンネルにも subscriber がある場合
      return Response.json({
        data: [url.pathname === '/helix/chat/badges/global' ? { ...channelBadges, versions: [{ id: '12', image_url_2x: 'https://example.test/全体の絵', title: 'Subscriber' }] } : channelBadges],
      })
    }
    const body = await fetchIt(env, '/api/chat/badges', fetchImpl).then((r) => r.json())

    expect(body).toEqual({
      badges: [{ setId: 'subscriber', versions: [{ id: '12', imageUrl: 'https://example.test/badges/subscriber-12/2', title: '1-Year Subscriber' }] }],
    })
  })

  it('一度取得した内容はKVに貯め、二度目はTwitchへ問い合わせない（キーの要らない経路なので、そのままでは呼ばれ放題になる）', async () => {
    const { env } = createEnv()
    const { urls, fetchImpl } = fakeTwitch()
    await fetchIt(env, '/api/chat/badges', fetchImpl)
    const firstFetchCount = urls.length
    const second = await fetchIt(env, '/api/chat/badges', fetchImpl)

    expect(urls.length).toBe(firstFetchCount)
    expect(second.status).toBe(200)
    expect(await second.json()).toHaveProperty('badges')
  })

  it('共有キャッシュに載せてよいことを伝える（誰が見ても同じ内容のため）', async () => {
    const { env } = createEnv()
    const { fetchImpl } = fakeTwitch()
    const response = await fetchIt(env, '/api/chat/badges', fetchImpl)
    expect(response.headers.get('Cache-Control')).toContain('public')
  })

  it('KVに貯めた内容が壊れていたら、取り直して上書きする（500で落とさない）', async () => {
    const { env, store } = createEnv()
    await store.put(`chat-badges:${broadcasterId}`, 'これはJSONではありません')
    const { fetchImpl } = fakeTwitch()
    const response = await fetchIt(env, '/api/chat/badges', fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toHaveProperty('badges')
  })

})

describe('GET /api/chat/cheermotes', () => {
  it('Cheermote の一覧を、段階ごとの最小ビッツ数・色・画像とともに返す', async () => {
    const { env } = createEnv()
    const { fetchImpl } = fakeTwitch()
    const response = await fetchIt(env, '/api/chat/cheermotes', fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      cheermotes: [{ prefix: 'Cheer', tiers: [{ minBits: 1, color: '#979797', imageUrl: 'https://example.test/cheer/1.gif' }] }],
    })
  })

  it('一度取得した内容はKVに貯め、二度目はTwitchへ問い合わせない', async () => {
    const { env } = createEnv()
    const { urls, fetchImpl } = fakeTwitch()
    await fetchIt(env, '/api/chat/cheermotes', fetchImpl)
    const firstFetchCount = urls.length
    await fetchIt(env, '/api/chat/cheermotes', fetchImpl)

    expect(urls.length).toBe(firstFetchCount)
  })

})

describe('GET /api/chat/channel', () => {
  it('このWorkerが扱う配信者のチャンネル名を返す（チャットボックスはURLにチャンネル名を持たないため）', async () => {
    const { env } = createEnv()
    const { fetchImpl } = fakeTwitch()
    const response = await fetchIt(env, '/api/chat/channel', fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ login: 'tanenob' })
  })

  it('一度取得した内容はKVに貯め、二度目はTwitchへ問い合わせない', async () => {
    const { env } = createEnv()
    const { urls, fetchImpl } = fakeTwitch()
    await fetchIt(env, '/api/chat/channel', fetchImpl)
    const firstFetchCount = urls.length
    await fetchIt(env, '/api/chat/channel', fetchImpl)

    expect(urls.length).toBe(firstFetchCount)
  })
})
