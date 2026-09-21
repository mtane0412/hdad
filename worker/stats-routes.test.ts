/**
 * 配信の記録の読み出し用API（/api/admin/stats/*）と、cron の入口（handleScheduled）のテスト
 *
 * KV・R2・D1を差し替え、handleRequest と handleScheduled を通して確かめる。
 */
import { describe, expect, it } from 'vitest'
import { createFakeBucket } from './fake-bucket'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'
import { handleRequest, handleScheduled, type Env } from './index'
import { createSessionToken } from './session'
import { recordFailure, recordFollowerTotal, recordLiveStream } from './stats-store'
import { saveToken } from './token'

const 現在時刻 = Date.parse('2026-09-21T12:10:00Z')
const 配信者のID = '12345'
const サイト = 'https://stream-assets.example.com'

const 環境を作る = () => {
  const db = createFakeDatabase()
  const store = createFakeStore()
  const env = {
    STORE: store,
    MEDIA: createFakeBucket(),
    DB: db,
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: 配信者のID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
  } satisfies Env
  return { env, db, store }
}

const Twitchへは通信しない = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

const 呼び出す = (request: Request, env: Env) => handleRequest(request, env, { fetch: Twitchへは通信しない, now: () => 現在時刻 })

const 配信者として取得する = async (env: Env, path: string): Promise<Response> => {
  const session = await createSessionToken(配信者のID, env.SESSION_SECRET, 現在時刻)
  return 呼び出す(new Request(`${サイト}${path}`, { headers: { Cookie: `__Host-session=${session}` } }), env)
}

const 雑談配信を記録する = async (env: Env): Promise<void> => {
  const 配信 = { id: '40000000001', startedAt: '2026-09-21T12:00:00.000Z', title: '月曜の雑談配信', categoryName: 'Just Chatting' }
  await recordFollowerTotal(env.DB, 100, Date.parse('2026-09-21T11:00:00Z'))
  await recordLiveStream(env.DB, { ...配信, viewerCount: 10 }, Date.parse('2026-09-21T12:05:00Z'))
  await recordLiveStream(env.DB, { ...配信, viewerCount: 20 }, Date.parse('2026-09-21T12:10:00Z'))
  await recordFollowerTotal(env.DB, 103, Date.parse('2026-09-21T12:10:00Z'))
}

describe('読み出し用APIの保護', () => {
  it.each(['/api/admin/stats/sessions', '/api/admin/stats/sessions/40000000001', '/api/admin/stats/followers', '/api/admin/stats/failures'])(
    '%s は配信者のセッションがなければ401になる',
    async (path) => {
      const { env } = 環境を作る()
      const response = await 呼び出す(new Request(`${サイト}${path}`), env)

      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ error: { code: 'unauthorized' } })
    },
  )
})

describe('GET /api/admin/stats/sessions', () => {
  it('配信セッションの一覧を、平均・最大視聴者数とフォロワー増減つきで返す', async () => {
    const { env } = 環境を作る()
    await 雑談配信を記録する(env)

    const response = await 配信者として取得する(env, '/api/admin/stats/sessions')

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
    const { env } = 環境を作る()
    expect(await (await 配信者として取得する(env, '/api/admin/stats/sessions')).json()).toEqual({ sessions: [] })
  })
})

describe('GET /api/admin/stats/sessions/:id', () => {
  it('配信セッションと視聴者数の時系列を返す', async () => {
    const { env } = 環境を作る()
    await 雑談配信を記録する(env)

    const response = await 配信者として取得する(env, '/api/admin/stats/sessions/40000000001')

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
    const { env } = 環境を作る()
    const response = await 配信者として取得する(env, '/api/admin/stats/sessions/99999999999')

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'session-not-found' } })
  })
})

describe('GET /api/admin/stats/followers', () => {
  it('フォロワー数の時系列を返す', async () => {
    const { env } = 環境を作る()
    await 雑談配信を記録する(env)

    expect(await (await 配信者として取得する(env, '/api/admin/stats/followers')).json()).toEqual({
      samples: [
        { sampledAt: '2026-09-21T11:00:00.000Z', followerTotal: 100 },
        { sampledAt: '2026-09-21T12:10:00.000Z', followerTotal: 103 },
      ],
    })
  })
})

describe('GET /api/admin/stats/failures', () => {
  it('収集の失敗の一覧を返す', async () => {
    const { env } = 環境を作る()
    await recordFailure(env.DB, 'relogin-required', 'Twitchのトークンを更新できませんでした。ログインし直してください', 現在時刻)

    expect(await (await 配信者として取得する(env, '/api/admin/stats/failures')).json()).toEqual({
      failures: [
        { occurredAt: '2026-09-21T12:10:00.000Z', code: 'relogin-required', message: 'Twitchのトークンを更新できませんでした。ログインし直してください' },
      ],
    })
  })
})

describe('handleScheduled（cron の入口）', () => {
  /** Helixの2つの取得にだけ応える fetch */
  const Helixの代役 = async (input: RequestInfo | URL): Promise<Response> => {
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
    const { env, store } = 環境を作る()
    await saveToken(store, {
      accessToken: '保管中のアクセストークン',
      refreshToken: '保管中のリフレッシュトークン',
      expiresAt: 現在時刻 + 60 * 60 * 1000,
      scopes: ['moderator:read:followers'],
      userId: 配信者のID,
      login: 'haishinsha',
    })

    await handleScheduled(env, { fetch: Helixの代役, now: () => 現在時刻 })

    const body = (await (await 配信者として取得する(env, '/api/admin/stats/sessions')).json()) as { sessions: unknown[] }
    expect(body.sessions).toMatchObject([{ id: '40000000001', peakViewers: 42 }])
  })

  it('配信者がログインしていなければ、失敗を記録してエラーにする', async () => {
    const { env } = 環境を作る()

    await expect(handleScheduled(env, { fetch: Helixの代役, now: () => 現在時刻 })).rejects.toMatchObject({ code: 'not-logged-in' })

    const body = (await (await 配信者として取得する(env, '/api/admin/stats/failures')).json()) as { failures: unknown[] }
    expect(body.failures).toMatchObject([{ code: 'not-logged-in' }])
  })

  it('Workerの環境変数が足りなければエラーにする', async () => {
    const { env } = 環境を作る()
    await expect(handleScheduled({ ...env, TWITCH_CLIENT_SECRET: '' }, { fetch: Helixの代役, now: () => 現在時刻 })).rejects.toThrow('TWITCH_CLIENT_SECRET')
  })
})
