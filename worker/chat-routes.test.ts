/**
 * チャットボックス向けの公開API（/api/chat/*）のテスト
 *
 * OBSのブラウザソース（chat/<id>/）から、キーもセッションも無しで呼ばれる経路。
 * Twitchへの通信を差し替え、「正しく中継するか」「同じ問い合わせを繰り返さないか（KVに貯める）」
 * 「おかしな指定を早めに断るか」を確かめる。
 */
import { describe, expect, it } from 'vitest'
import { createFakeBucket } from './fake-bucket'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'
import { handleRequest, type Env } from './index'

const 現在時刻 = Date.parse('2026-09-21T12:10:00Z')
const 配信者のID = '12345'
const サイト = 'https://stream-assets.example.com'

const 環境を作る = () => {
  const store = createFakeStore()
  const env = {
    STORE: store,
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: 配信者のID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
  } satisfies Env
  return { env, store }
}

/** グローバルの「配信者」バッジと、チャンネル固有の「サブスク」バッジ */
const 全体のバッジ = {
  set_id: 'broadcaster',
  versions: [{ id: '1', image_url_2x: 'https://example.test/badges/broadcaster/2', title: 'Broadcaster' }],
}
const チャンネルのバッジ = {
  set_id: 'subscriber',
  versions: [{ id: '12', image_url_2x: 'https://example.test/badges/subscriber-12/2', title: '1-Year Subscriber' }],
}
const cheermote = {
  prefix: 'Cheer',
  tiers: [{ min_bits: 1, color: '#979797', images: { dark: { animated: { '2': 'https://example.test/cheer/1.gif' } } } }],
}

/** Twitchの応答を、呼ばれたURLごとに決めて返す fetch。送られたURLも記録する */
const Twitchの代役 = () => {
  const urls: string[] = []
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    urls.push(url.origin + url.pathname + url.search)
    if (url.pathname === '/oauth2/token') return Response.json({ access_token: 'test-app-token', expires_in: 5000 })
    if (url.pathname === '/helix/chat/badges/global') return Response.json({ data: [全体のバッジ] })
    if (url.pathname === '/helix/chat/badges') return Response.json({ data: [チャンネルのバッジ] })
    if (url.pathname === '/helix/bits/cheermotes') return Response.json({ data: [cheermote] })
    throw new Error(`テストで想定していない通信です: ${url.toString()}`)
  }
  return { urls, fetchImpl }
}

const 取得する = (env: Env, path: string, fetchImpl: typeof fetch): Promise<Response> =>
  handleRequest(new Request(`${サイト}${path}`, { headers: { Origin: サイト } }), env, { fetch: fetchImpl, now: () => 現在時刻 })

describe('GET /api/chat/badges', () => {
  it('全体のバッジとチャンネル固有のバッジをまとめて返す（ログインもキーも要らない）', async () => {
    const { env } = 環境を作る()
    const { fetchImpl } = Twitchの代役()
    const response = await 取得する(env, `/api/chat/badges?broadcaster=${配信者のID}`, fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      badges: [
        { setId: 'broadcaster', versions: [{ id: '1', imageUrl: 'https://example.test/badges/broadcaster/2', title: 'Broadcaster' }] },
        { setId: 'subscriber', versions: [{ id: '12', imageUrl: 'https://example.test/badges/subscriber-12/2', title: '1-Year Subscriber' }] },
      ],
    })
  })

  it('チャンネル固有のバッジが、同じ種類の全体のバッジを上書きする（チャンネルのサブスクバッジを優先する）', async () => {
    const { env } = 環境を作る()
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname === '/oauth2/token') return Response.json({ access_token: 'test-app-token', expires_in: 5000 })
      // 全体にもチャンネルにも subscriber がある場合
      return Response.json({
        data: [url.pathname === '/helix/chat/badges/global' ? { ...チャンネルのバッジ, versions: [{ id: '12', image_url_2x: 'https://example.test/全体の絵', title: 'Subscriber' }] } : チャンネルのバッジ],
      })
    }
    const body = await 取得する(env, `/api/chat/badges?broadcaster=${配信者のID}`, fetchImpl).then((r) => r.json())

    expect(body).toEqual({
      badges: [{ setId: 'subscriber', versions: [{ id: '12', imageUrl: 'https://example.test/badges/subscriber-12/2', title: '1-Year Subscriber' }] }],
    })
  })

  it('一度取得した内容はKVに貯め、二度目はTwitchへ問い合わせない（キーの要らない経路なので、そのままでは呼ばれ放題になる）', async () => {
    const { env } = 環境を作る()
    const { urls, fetchImpl } = Twitchの代役()
    await 取得する(env, `/api/chat/badges?broadcaster=${配信者のID}`, fetchImpl)
    const 一度目の通信回数 = urls.length
    const 二度目 = await 取得する(env, `/api/chat/badges?broadcaster=${配信者のID}`, fetchImpl)

    expect(urls.length).toBe(一度目の通信回数)
    expect(二度目.status).toBe(200)
    expect(await 二度目.json()).toHaveProperty('badges')
  })

  it('共有キャッシュに載せてよいことを伝える（誰が見ても同じ内容のため）', async () => {
    const { env } = 環境を作る()
    const { fetchImpl } = Twitchの代役()
    const response = await 取得する(env, `/api/chat/badges?broadcaster=${配信者のID}`, fetchImpl)
    expect(response.headers.get('Cache-Control')).toContain('public')
  })

  it('KVに貯めた内容が壊れていたら、取り直して上書きする（500で落とさない）', async () => {
    const { env, store } = 環境を作る()
    await store.put(`chat-badges:${配信者のID}`, 'これはJSONではありません')
    const { fetchImpl } = Twitchの代役()
    const response = await 取得する(env, `/api/chat/badges?broadcaster=${配信者のID}`, fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toHaveProperty('badges')
  })

  it('この配信者以外のIDは、Twitchへ問い合わせる前に 403 で断る（キーの要らない経路から、他人のIDで呼ばせない）', async () => {
    const { env, store } = 環境を作る()
    const { urls, fetchImpl } = Twitchの代役()
    const response = await 取得する(env, '/api/chat/badges?broadcaster=99999', fetchImpl)

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'unsupported-broadcaster' } })
    expect(urls).toEqual([])
    // KVに知らないIDの項目を作らせない
    expect([...store.entries.keys()]).toEqual([])
  })

  it('broadcaster の指定が無ければ、400 で断る（黙って全体のバッジだけ返さない）', async () => {
    const { env } = 環境を作る()
    const { fetchImpl } = Twitchの代役()
    const response = await 取得する(env, '/api/chat/badges', fetchImpl)

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid-broadcaster' } })
  })

  it('broadcaster が数字でなければ、Twitchへ問い合わせる前に 400 で断る', async () => {
    const { env } = 環境を作る()
    const { urls, fetchImpl } = Twitchの代役()
    const response = await 取得する(env, '/api/chat/badges?broadcaster=あいうえお', fetchImpl)

    expect(response.status).toBe(400)
    expect(urls).toEqual([])
  })
})

describe('GET /api/chat/cheermotes', () => {
  it('Cheermote の一覧を、段階ごとの最小ビッツ数・色・画像とともに返す', async () => {
    const { env } = 環境を作る()
    const { fetchImpl } = Twitchの代役()
    const response = await 取得する(env, `/api/chat/cheermotes?broadcaster=${配信者のID}`, fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      cheermotes: [{ prefix: 'Cheer', tiers: [{ minBits: 1, color: '#979797', imageUrl: 'https://example.test/cheer/1.gif' }] }],
    })
  })

  it('一度取得した内容はKVに貯め、二度目はTwitchへ問い合わせない', async () => {
    const { env } = 環境を作る()
    const { urls, fetchImpl } = Twitchの代役()
    await 取得する(env, `/api/chat/cheermotes?broadcaster=${配信者のID}`, fetchImpl)
    const 一度目の通信回数 = urls.length
    await 取得する(env, `/api/chat/cheermotes?broadcaster=${配信者のID}`, fetchImpl)

    expect(urls.length).toBe(一度目の通信回数)
  })

  it('broadcaster が数字でなければ 400 で断る', async () => {
    const { env } = 環境を作る()
    const { fetchImpl } = Twitchの代役()
    expect((await 取得する(env, '/api/chat/cheermotes?broadcaster=-1', fetchImpl)).status).toBe(400)
  })
})
