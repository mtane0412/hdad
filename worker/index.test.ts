/**
 * WorkerのAPI（index.ts）のテスト
 *
 * Twitchへの通信とKVを差し替え、経路ごとの振る舞いを確認する。特に重要なのは次の3点。
 * - 配信者本人以外のTwitchアカウントではログインできないこと
 * - セッションのない人が管理用APIを使えないこと
 * - オーバーレイ用キーを知らない人が購読の代行を使えないこと
 */
import { describe, expect, it } from 'vitest'
import { REQUIRED_SCOPES } from './eventsub'
import { createFakeBucket } from './fake-bucket'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'
import { loadToken, saveToken } from './token'

const 現在時刻 = Date.UTC(2026, 8, 21, 12, 0, 0)
const 配信者のID = '12345'
const サイト = 'https://stream-assets.example.com'

const 環境を作る = (store = createFakeStore()) => {
  const env = {
    STORE: store,
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: 配信者のID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
  } satisfies Env
  return { env, store }
}

/** Twitchの代わりに応答する fetch。ログインしてきた人のユーザーIDだけ切り替えられる */
const Twitchの代役 = (loginUserId: string) => {
  const requests: Request[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    requests.push(request)
    if (request.url === 'https://id.twitch.tv/oauth2/token') {
      return Response.json({ access_token: 'test-access-token', refresh_token: 'リフレッシュトークン', expires_in: 14400 })
    }
    if (request.url === 'https://id.twitch.tv/oauth2/validate') {
      return Response.json({ user_id: loginUserId, login: 'haishinsha', scopes: REQUIRED_SCOPES })
    }
    if (request.url === 'https://api.twitch.tv/helix/eventsub/subscriptions') {
      return Response.json({ data: [] }, { status: 202 })
    }
    throw new Error(`テストで想定していない通信です: ${request.url}`)
  }
  return { requests, fetchImpl }
}

const 呼び出す = (request: Request, env: Env, fetchImpl: typeof fetch = Twitchの代役(配信者のID).fetchImpl) =>
  handleRequest(request, env, { fetch: fetchImpl, now: () => 現在時刻 })

const エラーコード = async (response: Response): Promise<unknown> => {
  const body = (await response.json()) as { error?: { code?: unknown } }
  return body.error?.code
}

/** ログイン開始 → 返ってきた state を使ってコールバックを呼ぶ、までをまとめて行う */
const ログインする = async (env: Env, fetchImpl: typeof fetch) => {
  const login = await 呼び出す(new Request(`${サイト}/api/auth/login`), env, fetchImpl)
  const state = new URL(login.headers.get('Location')!).searchParams.get('state')!
  const stateCookie = login.headers.getSetCookie()[0]!.split(';')[0]!
  return 呼び出す(
    new Request(`${サイト}/api/auth/callback?code=認可コード&state=${state}`, { headers: { Cookie: stateCookie } }),
    env,
    fetchImpl,
  )
}

describe('設定の検証', () => {
  it('必要な環境変数が欠けていたら、欠けている名前を示して500を返す', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(new Request(`${サイト}/api/me`), { ...env, TWITCH_CLIENT_SECRET: '' })

    expect(response.status).toBe(500)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain('TWITCH_CLIENT_SECRET')
  })
})

describe('GET /api/auth/login', () => {
  it('stateをクッキーに入れて、Twitchの認可ページへリダイレクトする', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(new Request(`${サイト}/api/auth/login`), env)

    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('Location')!)
    expect(location.hostname).toBe('id.twitch.tv')
    expect(location.searchParams.get('redirect_uri')).toBe(`${サイト}/api/auth/callback`)
    expect(location.searchParams.get('scope')).toBe(REQUIRED_SCOPES.join(' '))
    const state = location.searchParams.get('state')!
    expect(state.length).toBeGreaterThanOrEqual(32)
    const cookie = response.headers.getSetCookie()[0]!
    expect(cookie).toContain(`__Host-oauth-state=${state}`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
  })
})

describe('GET /api/auth/callback', () => {
  it('配信者本人がログインすると、トークンを保存し、オーバーレイ用キーを発行し、セッションを開始する', async () => {
    const { env, store } = 環境を作る()
    const response = await ログインする(env, Twitchの代役(配信者のID).fetchImpl)

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/')
    expect(await loadToken(store)).toMatchObject({
      accessToken: 'test-access-token',
      refreshToken: 'リフレッシュトークン',
      expiresAt: 現在時刻 + 14400 * 1000,
      userId: 配信者のID,
      login: 'haishinsha',
    })
    expect(store.entries.get('overlay-key')?.length).toBeGreaterThanOrEqual(32)
    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith('__Host-session='))).toBe(true)
  })

  it('配信者以外のアカウントは403で拒否し、トークンを保存しない', async () => {
    const { env, store } = 環境を作る()
    const response = await ログインする(env, Twitchの代役('99999').fetchImpl)

    expect(response.status).toBe(403)
    expect(await loadToken(store)).toBeNull()
    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith('__Host-session='))).toBe(false)
  })

  it('クッキーのstateと一致しないコールバックは、Twitchへ問い合わせずに400で拒否する', async () => {
    const { env } = 環境を作る()
    const twitch = Twitchの代役(配信者のID)
    const response = await 呼び出す(
      new Request(`${サイト}/api/auth/callback?code=認可コード&state=state-made-by-attacker`, {
        headers: { Cookie: '__Host-oauth-state=genuine-state' },
      }),
      env,
      twitch.fetchImpl,
    )

    expect(response.status).toBe(400)
    expect(twitch.requests).toHaveLength(0)
  })

  it('Twitchの認可画面で拒否された場合は400を返す', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(new Request(`${サイト}/api/auth/callback?error=access_denied&state=x`), env)
    expect(response.status).toBe(400)
  })

  it('再ログインしても、発行済みのオーバーレイ用キーは変えない（OBSに貼ったURLを無効にしないため）', async () => {
    const { env, store } = 環境を作る(createFakeStore({ 'overlay-key': '発行済みのオーバーレイ用キー' }))
    await ログインする(env, Twitchの代役(配信者のID).fetchImpl)
    expect(store.entries.get('overlay-key')).toBe('発行済みのオーバーレイ用キー')
  })
})

describe('GET /api/me', () => {
  it('セッションがなければ401を返す', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(new Request(`${サイト}/api/me`), env)
    expect(response.status).toBe(401)
    expect(await エラーコード(response)).toBe('unauthorized')
  })

  it('配信者のセッションがあれば、ログイン名とオーバーレイ用キーを返す', async () => {
    const { env, store } = 環境を作る(createFakeStore({ 'overlay-key': '発行済みのオーバーレイ用キー' }))
    await saveToken(store, {
      accessToken: 'test-access-token',
      refreshToken: 'リフレッシュトークン',
      expiresAt: 現在時刻 + 1000,
      scopes: [...REQUIRED_SCOPES],
      userId: 配信者のID,
      login: 'haishinsha',
    })
    const session = await createSessionToken(配信者のID, env.SESSION_SECRET, 現在時刻)
    const response = await 呼び出す(new Request(`${サイト}/api/me`, { headers: { Cookie: `__Host-session=${session}` } }), env)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ userId: 配信者のID, login: 'haishinsha', overlayKey: '発行済みのオーバーレイ用キー' })
    // トークンそのものはブラウザへ出さない
    expect(JSON.stringify(body)).not.toContain('test-access-token')
  })

  it('配信者ではないユーザーIDのセッションは401にする（環境変数の配信者IDを変えた後など）', async () => {
    const { env } = 環境を作る()
    const session = await createSessionToken('99999', env.SESSION_SECRET, 現在時刻)
    const response = await 呼び出す(new Request(`${サイト}/api/me`, { headers: { Cookie: `__Host-session=${session}` } }), env)
    expect(response.status).toBe(401)
  })
})

describe('POST /api/auth/logout', () => {
  it('セッションのクッキーを消す', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(new Request(`${サイト}/api/auth/logout`, { method: 'POST' }), env)
    expect(response.status).toBe(204)
    expect(response.headers.getSetCookie()[0]).toContain('Max-Age=0')
  })
})

describe('POST /api/eventsub/subscriptions', () => {
  const 購読を頼む = (body: unknown) =>
    new Request(`${サイト}/api/eventsub/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('正しいオーバーレイ用キーなら、保管しているトークンで購読を登録する', async () => {
    const { env } = 環境を作る()
    const twitch = Twitchの代役(配信者のID)
    await ログインする(env, twitch.fetchImpl)
    const overlayKey = env.STORE.entries.get('overlay-key')

    const response = await 呼び出す(購読を頼む({ key: overlayKey, sessionId: 'セッションID' }), env, twitch.fetchImpl)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { types: string[] }
    expect(body.types).toContain('channel.channel_points_custom_reward_redemption.add')
    const helixRequests = twitch.requests.filter((request) => request.url.includes('/helix/eventsub/subscriptions'))
    expect(helixRequests).toHaveLength(body.types.length)
  })

  it('オーバーレイ用キーが違えば401で拒否し、Twitchへは何も送らない', async () => {
    const { env } = 環境を作る(createFakeStore({ 'overlay-key': '発行済みのオーバーレイ用キー' }))
    const twitch = Twitchの代役(配信者のID)

    const response = await 呼び出す(購読を頼む({ key: '当てずっぽうのキー', sessionId: 'セッションID' }), env, twitch.fetchImpl)

    expect(response.status).toBe(401)
    expect(await エラーコード(response)).toBe('invalid-overlay-key')
    expect(twitch.requests).toHaveLength(0)
  })

  it('キーがまだ発行されていない（一度もログインしていない）場合も401で拒否する', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(購読を頼む({ key: '', sessionId: 'セッションID' }), env)
    expect(response.status).toBe(401)
  })

  it('キーは正しいがトークンが保存されていなければ、未ログインのエラーを返す', async () => {
    const { env } = 環境を作る(createFakeStore({ 'overlay-key': '発行済みのオーバーレイ用キー' }))
    const response = await 呼び出す(購読を頼む({ key: '発行済みのオーバーレイ用キー', sessionId: 'セッションID' }), env)
    expect(response.status).toBe(401)
    expect(await エラーコード(response)).toBe('not-logged-in')
  })

  it('本文の形式が違えば400を返す', async () => {
    const { env } = 環境を作る(createFakeStore({ 'overlay-key': '発行済みのオーバーレイ用キー' }))
    const response = await 呼び出す(購読を頼む({ key: '発行済みのオーバーレイ用キー' }), env)
    expect(response.status).toBe(400)
  })
})

describe('その他の経路', () => {
  it('知らないパスは404を返す', async () => {
    const { env } = 環境を作る()
    expect((await 呼び出す(new Request(`${サイト}/api/unknown`), env)).status).toBe(404)
  })

  it('メソッドが違えば405を返す', async () => {
    const { env } = 環境を作る()
    expect((await 呼び出す(new Request(`${サイト}/api/auth/logout`), env)).status).toBe(405)
  })
})
