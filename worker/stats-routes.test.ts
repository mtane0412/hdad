/**
 * 配信の記録の読み出し用API（/api/admin/stats/*）と、cron の入口（handleScheduled）のテスト
 *
 * KV・R2・D1を差し替え、handleRequest と handleScheduled を通して確かめる。
 */
import { describe, expect, it } from 'vitest'
import { createFakeBucket } from './fake-bucket'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeTokenVault } from './fake-token-vault'
import { createFakeDatabase } from './fake-database'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeTabChannel } from './fake-tab-channel'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeStore } from './fake-store'
import { handleRequest, handleScheduled, type Env } from './index'
import { createSessionToken } from './session'
import { recordFailure, recordFollowerTotal, recordLiveStream } from './stats-store'
import { saveToken } from './token'

const NOW = Date.parse('2026-09-21T12:10:00Z')
const BROADCASTER_ID = '12345'
const SITE = 'https://hdad.example.com'

const createEnv = () => {
  const db = createFakeDatabase()
  const store = createFakeStore()
  const env = {
    STORE: store,
    MEDIA: createFakeBucket(),
    DB: db,
    ASSETS: createFakeAssets(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: BROADCASTER_ID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: createFakeAlertChannel().namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    TOKENS: createFakeTokenVault().namespace,
    AI: createFakeWorkersAi(),
  } satisfies Env
  return { env, db, store }
}

const noTwitchFetch = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
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

const callApi = (request: Request, env: Env) => handleRequest(request, env, { fetch: noTwitchFetch, now: () => NOW, wait: noWait, waitUntil: noDefer })

const fetchAsBroadcaster = async (env: Env, path: string): Promise<Response> => {
  const session = await createSessionToken(BROADCASTER_ID, env.SESSION_SECRET, NOW)
  return callApi(new Request(`${SITE}${path}`, { headers: { Cookie: `__Host-session=${session}` } }), env)
}

const recordChatStream = async (env: Env): Promise<void> => {
  const stream = { id: '40000000001', startedAt: '2026-09-21T12:00:00.000Z', title: '月曜の雑談配信', categoryName: 'Just Chatting' }
  await recordFollowerTotal(env.DB, 100, Date.parse('2026-09-21T11:00:00Z'))
  await recordLiveStream(env.DB, { ...stream, viewerCount: 10 }, Date.parse('2026-09-21T12:05:00Z'))
  await recordLiveStream(env.DB, { ...stream, viewerCount: 20 }, Date.parse('2026-09-21T12:10:00Z'))
  await recordFollowerTotal(env.DB, 103, Date.parse('2026-09-21T12:10:00Z'))
}

describe('読み出し用APIの保護', () => {
  it.each(['/api/admin/stats/sessions', '/api/admin/stats/sessions/40000000001', '/api/admin/stats/followers', '/api/admin/stats/failures'])(
    '%s は配信者のセッションがなければ401になる',
    async (path) => {
      const { env } = createEnv()
      const response = await callApi(new Request(`${SITE}${path}`), env)

      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ error: { code: 'unauthorized' } })
    },
  )
})

describe('GET /api/admin/stats/sessions', () => {
  it('配信セッションの一覧を、平均・最大視聴者数とフォロワー増減つきで返す', async () => {
    const { env } = createEnv()
    await recordChatStream(env)

    const response = await fetchAsBroadcaster(env, '/api/admin/stats/sessions')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      sessions: [
        {
          id: '40000000001',
          startedAt: '2026-09-21T12:00:00.000Z',
          endedAt: null,
          title: '月曜の雑談配信',
          categoryName: 'Just Chatting',
          averageViewers: 15,
          peakViewers: 20,
          followerDelta: 3,
          eventCounts: {},
        },
      ],
    })
  })

  it('記録がまだ無ければ、空の一覧を返す', async () => {
    const { env } = createEnv()
    expect(await (await fetchAsBroadcaster(env, '/api/admin/stats/sessions')).json()).toEqual({ sessions: [] })
  })
})

describe('GET /api/admin/stats/sessions/:id', () => {
  it('配信セッションと視聴者数の時系列を返す', async () => {
    const { env } = createEnv()
    await recordChatStream(env)

    const response = await fetchAsBroadcaster(env, '/api/admin/stats/sessions/40000000001')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      id: '40000000001',
      title: '月曜の雑談配信',
      samples: [
        { sampledAt: '2026-09-21T12:05:00.000Z', viewerCount: 10 },
        { sampledAt: '2026-09-21T12:10:00.000Z', viewerCount: 20 },
      ],
    })
  })

  it('存在しない配信は404になる', async () => {
    const { env } = createEnv()
    const response = await fetchAsBroadcaster(env, '/api/admin/stats/sessions/99999999999')

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'session-not-found' } })
  })
})

describe('GET /api/admin/stats/followers', () => {
  it('フォロワー数の時系列を返す', async () => {
    const { env } = createEnv()
    await recordChatStream(env)

    expect(await (await fetchAsBroadcaster(env, '/api/admin/stats/followers')).json()).toEqual({
      samples: [
        { sampledAt: '2026-09-21T11:00:00.000Z', followerTotal: 100 },
        { sampledAt: '2026-09-21T12:10:00.000Z', followerTotal: 103 },
      ],
    })
  })
})

describe('GET /api/admin/stats/failures', () => {
  it('収集の失敗の一覧を返す', async () => {
    const { env } = createEnv()
    await recordFailure(env.DB, 'relogin-required', 'Twitchのトークンを更新できませんでした。ログインし直してください', NOW)

    expect(await (await fetchAsBroadcaster(env, '/api/admin/stats/failures')).json()).toEqual({
      failures: [
        { occurredAt: '2026-09-21T12:10:00.000Z', code: 'relogin-required', message: 'Twitchのトークンを更新できませんでした。ログインし直してください' },
      ],
    })
  })
})

describe('handleScheduled（cron の入口）', () => {
  /** Helixの2つの取得にだけ応える fetch */
  const fakeHelix = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input))
    if (url.pathname === '/helix/streams') {
      return Response.json({
        data: [{ id: '40000000001', game_name: 'Just Chatting', title: '月曜の雑談配信', viewer_count: 42, started_at: '2026-09-21T12:00:00Z' }],
      })
    }
    if (url.pathname === '/helix/channels/followers') return Response.json({ total: 1234, data: [] })
    throw new Error(`テストで想定していない通信です: ${url.toString()}`)
  }

  it('保管しているトークンでTwitchから取得し、配信とフォロワー数を記録する', async () => {
    const { env } = createEnv()
    await saveToken(env.TOKENS, 'broadcaster', {
      accessToken: '保管中のアクセストークン',
      refreshToken: '保管中のリフレッシュトークン',
      expiresAt: NOW + 60 * 60 * 1000,
      scopes: ['moderator:read:followers'],
      userId: BROADCASTER_ID,
      login: 'haishinsha',
    })

    await handleScheduled(env, { fetch: fakeHelix, now: () => NOW })

    const body = (await (await fetchAsBroadcaster(env, '/api/admin/stats/sessions')).json()) as { sessions: unknown[] }
    expect(body.sessions).toMatchObject([{ id: '40000000001', peakViewers: 42 }])
  })

  it('配信者がログインしていなければ、失敗を記録してエラーにする', async () => {
    const { env } = createEnv()

    await expect(handleScheduled(env, { fetch: fakeHelix, now: () => NOW })).rejects.toMatchObject({ code: 'not-logged-in' })

    const body = (await (await fetchAsBroadcaster(env, '/api/admin/stats/failures')).json()) as { failures: unknown[] }
    expect(body.failures).toMatchObject([{ code: 'not-logged-in' }])
  })

  it('Workerの環境変数が足りなければエラーにする', async () => {
    const { env } = createEnv()
    await expect(handleScheduled({ ...env, TWITCH_CLIENT_SECRET: '' }, { fetch: fakeHelix, now: () => NOW })).rejects.toThrow('TWITCH_CLIENT_SECRET')
  })
})
