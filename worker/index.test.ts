/**
 * WorkerのAPI（index.ts）のテスト
 *
 * Twitchへの通信とKVを差し替え、経路ごとの振る舞いを確認する。特に重要なのは次の3点。
 * - 配信者本人以外のTwitchアカウントではログインできないこと
 * - セッションのない人が管理用APIを使えないこと
 * - 知らないパスや違うメソッドを黙って通さないこと
 */
import { describe, expect, it } from 'vitest'
import { BOT_SCOPES, REQUIRED_SCOPES } from './eventsub'
import { webhookEventTypes } from './eventsub-webhook'
import { createFakeBucket } from './fake-bucket'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeDatabase } from './fake-database'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeStore } from './fake-store'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'
import { listFailures } from './stats-store'
import { loadToken, saveToken } from './token'

const now = Date.UTC(2026, 8, 21, 12, 0, 0)
const broadcasterId = '12345'
const site = 'https://hdad.example.com'

const createEnv = (store = createFakeStore()) => {
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

/** Twitchの代わりに応答する fetch。ログインしてきた人のユーザーID・ログイン名・スコープを切り替えられる */
const fakeTwitch = (loginUserId: string, owner: { login?: string; scopes?: readonly string[] } = {}) => {
  const requests: Request[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    requests.push(request)
    if (request.url === 'https://id.twitch.tv/oauth2/token') {
      return Response.json({ access_token: 'test-access-token', refresh_token: 'リフレッシュトークン', expires_in: 14400 })
    }
    if (request.url === 'https://id.twitch.tv/oauth2/validate') {
      return Response.json({ user_id: loginUserId, login: owner.login ?? 'haishinsha', scopes: owner.scopes ?? REQUIRED_SCOPES })
    }
    if (request.url === 'https://api.twitch.tv/helix/eventsub/subscriptions') {
      return Response.json({ data: [] }, { status: 202 })
    }
    throw new Error(`テストで想定していない通信です: ${request.url}`)
  }
  return { requests, fetchImpl }
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

const call = (request: Request, env: Env, fetchImpl: typeof fetch = fakeTwitch(broadcasterId).fetchImpl) =>
  handleRequest(request, env, { fetch: fetchImpl, now: () => now, wait: noWait, waitUntil: noDefer })

const errorCode = async (response: Response): Promise<unknown> => {
  const body = (await response.json()) as { error?: { code?: unknown } }
  return body.error?.code
}

/** ログイン開始 → 返ってきた state を使ってコールバックを呼ぶ、までをまとめて行う */
const loginAs = async (env: Env, fetchImpl: typeof fetch) => {
  const login = await call(new Request(`${site}/api/auth/login`), env, fetchImpl)
  const state = new URL(login.headers.get('Location')!).searchParams.get('state')!
  const stateCookie = login.headers.getSetCookie()[0]!.split(';')[0]!
  return call(
    new Request(`${site}/api/auth/callback?code=認可コード&state=${state}`, { headers: { Cookie: stateCookie } }),
    env,
    fetchImpl,
  )
}

/** 配信者としてログイン済みであることを表すセッションのクッキー */
const broadcasterSessionCookie = async (env: Env) => `__Host-session=${await createSessionToken(broadcasterId, env.SESSION_SECRET, now)}`

/** botの接続を開始 → 返ってきた state を使ってコールバックを呼ぶ、までをまとめて行う */
const connectBot = async (env: Env, fetchImpl: typeof fetch) => {
  const session = await broadcasterSessionCookie(env)
  const login = await call(new Request(`${site}/api/auth/login?role=bot`, { headers: { Cookie: session } }), env, fetchImpl)
  const state = new URL(login.headers.get('Location')!).searchParams.get('state')!
  const stateCookie = login.headers.getSetCookie()[0]!.split(';')[0]!
  return call(
    new Request(`${site}/api/auth/callback?code=認可コード&state=${state}`, { headers: { Cookie: `${session}; ${stateCookie}` } }),
    env,
    fetchImpl,
  )
}

describe('設定の検証', () => {
  it('必要な環境変数が欠けていたら、欠けている名前を示して500を返す', async () => {
    const { env } = createEnv()
    const response = await call(new Request(`${site}/api/me`), { ...env, TWITCH_CLIENT_SECRET: '' })

    expect(response.status).toBe(500)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain('TWITCH_CLIENT_SECRET')
  })
})

describe('GET /api/auth/login', () => {
  it('stateをクッキーに入れて、Twitchの認可ページへリダイレクトする', async () => {
    const { env } = createEnv()
    const response = await call(new Request(`${site}/api/auth/login`), env)

    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('Location')!)
    expect(location.hostname).toBe('id.twitch.tv')
    expect(location.searchParams.get('redirect_uri')).toBe(`${site}/api/auth/callback`)
    expect(location.searchParams.get('scope')).toBe(REQUIRED_SCOPES.join(' '))
    const state = location.searchParams.get('state')!
    expect(state.length).toBeGreaterThanOrEqual(32)
    const cookie = response.headers.getSetCookie()[0]!
    expect(cookie).toContain(`__Host-oauth-state=${state}`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
  })
})

describe('GET /api/auth/login?role=bot', () => {
  it('配信者のセッションがなければ401を返す（誰でもbotアカウントを差し替えられないようにする）', async () => {
    const { env } = createEnv()
    const response = await call(new Request(`${site}/api/auth/login?role=bot`), env)

    expect(response.status).toBe(401)
    expect(await errorCode(response)).toBe('unauthorized')
  })

  it('配信者のセッションがあれば、botのスコープでTwitchの認可ページへ送る', async () => {
    const { env } = createEnv()
    const response = await call(
      new Request(`${site}/api/auth/login?role=bot`, { headers: { Cookie: await broadcasterSessionCookie(env) } }),
      env,
    )

    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('Location')!)
    expect(location.searchParams.get('scope')).toBe(BOT_SCOPES.join(' '))
  })

  it('知らない役割を指定されたら400で拒否する', async () => {
    const { env } = createEnv()
    const response = await call(
      new Request(`${site}/api/auth/login?role=moderator`, { headers: { Cookie: await broadcasterSessionCookie(env) } }),
      env,
    )

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('invalid-role')
  })
})

describe('GET /api/auth/callback（botの接続）', () => {
  it('配信者とは別のアカウントでも、botとして接続できる', async () => {
    const { env, store } = createEnv()
    const twitch = fakeTwitch('67890', { login: 'haishinsha_bot', scopes: BOT_SCOPES })

    const response = await connectBot(env, twitch.fetchImpl)

    expect(response.status).toBe(302)
    expect(await loadToken(store, 'bot')).toMatchObject({ userId: '67890', login: 'haishinsha_bot' })
    // 配信者のトークンは書き換えない
    expect(await loadToken(store, 'broadcaster')).toBeNull()
  })

  it('botの接続では、配信者のセッションを新たに発行しない', async () => {
    const { env } = createEnv()
    const twitch = fakeTwitch('67890', { login: 'haishinsha_bot', scopes: BOT_SCOPES })

    const response = await connectBot(env, twitch.fetchImpl)

    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith('__Host-session='))).toBe(false)
  })

  it('botを接続しても、Webhook宛ての購読には触れない（チャットの購読は配信者だけで決まるため）', async () => {
    const { env } = createEnv()
    const twitch = fakeTwitch('67890', { login: 'haishinsha_bot', scopes: BOT_SCOPES })
    // fetch に渡した Request の本文は一度しか読めないので、送られた時点で控えておく
    const registeredSubscription: { type: string; condition: Record<string, string> }[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      if (request.method === 'POST' && request.url === 'https://api.twitch.tv/helix/eventsub/subscriptions') {
        registeredSubscription.push((await request.clone().json()) as { type: string; condition: Record<string, string> })
      }
      return twitch.fetchImpl(request)
    }

    await connectBot(env, fetchImpl)

    expect(registeredSubscription).toEqual([])
  })

  it('配信者のセッションが切れていたら、botのトークンを保存しない', async () => {
    const { env, store } = createEnv()
    const twitch = fakeTwitch('67890', { login: 'haishinsha_bot', scopes: BOT_SCOPES })
    const session = await broadcasterSessionCookie(env)
    const login = await call(new Request(`${site}/api/auth/login?role=bot`, { headers: { Cookie: session } }), env, twitch.fetchImpl)
    const state = new URL(login.headers.get('Location')!).searchParams.get('state')!
    const stateCookie = login.headers.getSetCookie()[0]!.split(';')[0]!

    // 認可画面にいる間にログアウトした（セッションのクッキーを付けずに戻ってきた）場合
    const response = await call(
      new Request(`${site}/api/auth/callback?code=認可コード&state=${state}`, { headers: { Cookie: stateCookie } }),
      env,
      twitch.fetchImpl,
    )

    expect(response.status).toBe(401)
    expect(await loadToken(store, 'bot')).toBeNull()
  })
})

describe('GET /api/auth/callback', () => {
  it('配信者本人がログインすると、トークンを保存し、オーバーレイ用キーを発行し、セッションを開始する', async () => {
    const { env, store } = createEnv()
    const response = await loginAs(env, fakeTwitch(broadcasterId).fetchImpl)

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/')
    expect(await loadToken(store, 'broadcaster')).toMatchObject({
      accessToken: 'test-access-token',
      refreshToken: 'リフレッシュトークン',
      expiresAt: now + 14400 * 1000,
      userId: broadcasterId,
      login: 'haishinsha',
    })
    expect(store.entries.get('overlay-key')?.length).toBeGreaterThanOrEqual(32)
    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith('__Host-session='))).toBe(true)
  })

  it('配信者以外のアカウントは403で拒否し、トークンを保存しない', async () => {
    const { env, store } = createEnv()
    const response = await loginAs(env, fakeTwitch('99999').fetchImpl)

    expect(response.status).toBe(403)
    expect(await loadToken(store, 'broadcaster')).toBeNull()
    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith('__Host-session='))).toBe(false)
  })

  it('クッキーのstateと一致しないコールバックは、Twitchへ問い合わせずに400で拒否する', async () => {
    const { env } = createEnv()
    const twitch = fakeTwitch(broadcasterId)
    const response = await call(
      new Request(`${site}/api/auth/callback?code=認可コード&state=state-made-by-attacker`, {
        headers: { Cookie: '__Host-oauth-state=genuine-state' },
      }),
      env,
      twitch.fetchImpl,
    )

    expect(response.status).toBe(400)
    expect(twitch.requests).toHaveLength(0)
  })

  it('Twitchの認可画面で拒否された場合は400を返す', async () => {
    const { env } = createEnv()
    const response = await call(new Request(`${site}/api/auth/callback?error=access_denied&state=x`), env)
    expect(response.status).toBe(400)
  })

  it('ログインすると、配信の記録のためのWebhook宛ての購読を登録する', async () => {
    const { env } = createEnv()
    const twitch = fakeTwitch(broadcasterId)
    // fetch に渡した Request の本文は一度しか読めないので、送られた時点で控えておく
    const registeredSubscription: { type: string; transport: unknown }[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      if (request.method === 'POST' && request.url === 'https://api.twitch.tv/helix/eventsub/subscriptions') {
        registeredSubscription.push((await request.clone().json()) as { type: string; transport: unknown })
      }
      return twitch.fetchImpl(request)
    }
    await loginAs(env, fetchImpl)

    // botを接続していない状態なので、チャットは購読しない
    expect(registeredSubscription.map((subscription) => subscription.type)).toEqual(webhookEventTypes())
    for (const subscription of registeredSubscription) {
      expect(subscription.transport).toEqual({
        method: 'webhook',
        callback: `${site}/api/eventsub/webhook`,
        secret: 'テスト用のWebhookシークレット',
      })
    }
  })

  it('Webhook宛ての購読に失敗しても、ログインは続ける。失敗は収集の失敗として記録する（ログインできないと失敗の記録も読めないため）', async () => {
    const { env } = createEnv()
    const twitch = fakeTwitch(broadcasterId)
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      if (request.method === 'POST' && request.url === 'https://api.twitch.tv/helix/eventsub/subscriptions') {
        return Response.json({ error: 'Forbidden', status: 403, message: 'subscription missing proper authorization' }, { status: 403 })
      }
      return twitch.fetchImpl(request)
    }
    const response = await loginAs(env, fetchImpl)

    expect(response.status).toBe(302)
    expect(await listFailures(env.DB)).toMatchObject([
      { code: 'webhook-subscription-failed', message: expect.stringContaining('subscription missing proper authorization') },
    ])
  })

  it('https でないサイト（ローカルの開発サーバー）では、Webhook宛ての購読を登録しない（Twitchが https のURLしか受け付けないため）', async () => {
    const { env } = createEnv()
    const twitch = fakeTwitch(broadcasterId)
    const local = 'http://localhost:5173'
    const login = await call(new Request(`${local}/api/auth/login`), env, twitch.fetchImpl)
    const state = new URL(login.headers.get('Location')!).searchParams.get('state')!
    const stateCookie = login.headers.getSetCookie()[0]!.split(';')[0]!
    const response = await call(
      new Request(`${local}/api/auth/callback?code=認可コード&state=${state}`, { headers: { Cookie: stateCookie } }),
      env,
      twitch.fetchImpl,
    )

    expect(response.status).toBe(302)
    expect(twitch.requests.filter((request) => request.url.includes('/helix/eventsub/subscriptions'))).toHaveLength(0)
  })

  it('再ログインしても、発行済みのオーバーレイ用キーは変えない（OBSに貼ったURLを無効にしないため）', async () => {
    const { env, store } = createEnv(createFakeStore({ 'overlay-key': '発行済みのオーバーレイ用キー' }))
    await loginAs(env, fakeTwitch(broadcasterId).fetchImpl)
    expect(store.entries.get('overlay-key')).toBe('発行済みのオーバーレイ用キー')
  })
})

describe('GET /api/me', () => {
  it('セッションがなければ401を返す', async () => {
    const { env } = createEnv()
    const response = await call(new Request(`${site}/api/me`), env)
    expect(response.status).toBe(401)
    expect(await errorCode(response)).toBe('unauthorized')
  })

  it('配信者のセッションがあれば、ログイン名とオーバーレイ用キーを返す', async () => {
    const { env, store } = createEnv(createFakeStore({ 'overlay-key': '発行済みのオーバーレイ用キー' }))
    await saveToken(store, 'broadcaster', {
      accessToken: 'test-access-token',
      refreshToken: 'リフレッシュトークン',
      expiresAt: now + 1000,
      scopes: [...REQUIRED_SCOPES],
      userId: broadcasterId,
      login: 'haishinsha',
    })
    const session = await createSessionToken(broadcasterId, env.SESSION_SECRET, now)
    const response = await call(new Request(`${site}/api/me`, { headers: { Cookie: `__Host-session=${session}` } }), env)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ userId: broadcasterId, login: 'haishinsha', overlayKey: '発行済みのオーバーレイ用キー' })
    // トークンそのものはブラウザへ出さない
    expect(JSON.stringify(body)).not.toContain('test-access-token')
  })

  it('配信者ではないユーザーIDのセッションは401にする（環境変数の配信者IDを変えた後など）', async () => {
    const { env } = createEnv()
    const session = await createSessionToken('99999', env.SESSION_SECRET, now)
    const response = await call(new Request(`${site}/api/me`, { headers: { Cookie: `__Host-session=${session}` } }), env)
    expect(response.status).toBe(401)
  })
})

describe('POST /api/auth/logout', () => {
  it('セッションのクッキーを消す', async () => {
    const { env } = createEnv()
    const response = await call(new Request(`${site}/api/auth/logout`, { method: 'POST' }), env)
    expect(response.status).toBe(204)
    expect(response.headers.getSetCookie()[0]).toContain('Max-Age=0')
  })
})

describe('その他の経路', () => {
  it('知らないパスは404を返す', async () => {
    const { env } = createEnv()
    expect((await call(new Request(`${site}/api/unknown`), env)).status).toBe(404)
  })

  it('メソッドが違えば405を返す', async () => {
    const { env } = createEnv()
    expect((await call(new Request(`${site}/api/auth/logout`), env)).status).toBe(405)
  })
})
