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
import { createFakeDatabase } from './fake-database'
import { createFakeAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeStore } from './fake-store'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'
import { listFailures } from './stats-store'
import { loadToken, saveToken } from './token'

const 現在時刻 = Date.UTC(2026, 8, 21, 12, 0, 0)
const 配信者のID = '12345'
const サイト = 'https://hdad.example.com'

const 環境を作る = (store = createFakeStore()) => {
  const env = {
    STORE: store,
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: 配信者のID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: createFakeAlertChannel().namespace,
    AI: createFakeAi(),
  } satisfies Env
  return { env, store }
}

/** Twitchの代わりに応答する fetch。ログインしてきた人のユーザーID・ログイン名・スコープを切り替えられる */
const Twitchの代役 = (loginUserId: string, owner: { login?: string; scopes?: readonly string[] } = {}) => {
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
const 待たない = async (): Promise<void> => {}

/**
 * これらの経路は応答のあとに続く処理（waitUntil）を使わない。
 * 黙って捨てると気づけなくなるので、預けられたら失敗させる（使うのは webhook-routes.test.ts だけ）。
 */
const 後回しにしない = (): void => {
  throw new Error('このテストでは、応答のあとに続く処理を使いません')
}

const 呼び出す = (request: Request, env: Env, fetchImpl: typeof fetch = Twitchの代役(配信者のID).fetchImpl) =>
  handleRequest(request, env, { fetch: fetchImpl, now: () => 現在時刻, wait: 待たない, waitUntil: 後回しにしない })

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

/** 配信者としてログイン済みであることを表すセッションのクッキー */
const 配信者のセッションクッキー = async (env: Env) => `__Host-session=${await createSessionToken(配信者のID, env.SESSION_SECRET, 現在時刻)}`

/** botの接続を開始 → 返ってきた state を使ってコールバックを呼ぶ、までをまとめて行う */
const botを接続する = async (env: Env, fetchImpl: typeof fetch) => {
  const session = await 配信者のセッションクッキー(env)
  const login = await 呼び出す(new Request(`${サイト}/api/auth/login?role=bot`, { headers: { Cookie: session } }), env, fetchImpl)
  const state = new URL(login.headers.get('Location')!).searchParams.get('state')!
  const stateCookie = login.headers.getSetCookie()[0]!.split(';')[0]!
  return 呼び出す(
    new Request(`${サイト}/api/auth/callback?code=認可コード&state=${state}`, { headers: { Cookie: `${session}; ${stateCookie}` } }),
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

describe('GET /api/auth/login?role=bot', () => {
  it('配信者のセッションがなければ401を返す（誰でもbotアカウントを差し替えられないようにする）', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(new Request(`${サイト}/api/auth/login?role=bot`), env)

    expect(response.status).toBe(401)
    expect(await エラーコード(response)).toBe('unauthorized')
  })

  it('配信者のセッションがあれば、botのスコープでTwitchの認可ページへ送る', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(
      new Request(`${サイト}/api/auth/login?role=bot`, { headers: { Cookie: await 配信者のセッションクッキー(env) } }),
      env,
    )

    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('Location')!)
    expect(location.searchParams.get('scope')).toBe(BOT_SCOPES.join(' '))
  })

  it('知らない役割を指定されたら400で拒否する', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(
      new Request(`${サイト}/api/auth/login?role=moderator`, { headers: { Cookie: await 配信者のセッションクッキー(env) } }),
      env,
    )

    expect(response.status).toBe(400)
    expect(await エラーコード(response)).toBe('invalid-role')
  })
})

describe('GET /api/auth/callback（botの接続）', () => {
  it('配信者とは別のアカウントでも、botとして接続できる', async () => {
    const { env, store } = 環境を作る()
    const twitch = Twitchの代役('67890', { login: 'haishinsha_bot', scopes: BOT_SCOPES })

    const response = await botを接続する(env, twitch.fetchImpl)

    expect(response.status).toBe(302)
    expect(await loadToken(store, 'bot')).toMatchObject({ userId: '67890', login: 'haishinsha_bot' })
    // 配信者のトークンは書き換えない
    expect(await loadToken(store, 'broadcaster')).toBeNull()
  })

  it('botの接続では、配信者のセッションを新たに発行しない', async () => {
    const { env } = 環境を作る()
    const twitch = Twitchの代役('67890', { login: 'haishinsha_bot', scopes: BOT_SCOPES })

    const response = await botを接続する(env, twitch.fetchImpl)

    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith('__Host-session='))).toBe(false)
  })

  it('botを接続しても、Webhook宛ての購読には触れない（チャットの購読は配信者だけで決まるため）', async () => {
    const { env } = 環境を作る()
    const twitch = Twitchの代役('67890', { login: 'haishinsha_bot', scopes: BOT_SCOPES })
    // fetch に渡した Request の本文は一度しか読めないので、送られた時点で控えておく
    const 登録した購読: { type: string; condition: Record<string, string> }[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      if (request.method === 'POST' && request.url === 'https://api.twitch.tv/helix/eventsub/subscriptions') {
        登録した購読.push((await request.clone().json()) as { type: string; condition: Record<string, string> })
      }
      return twitch.fetchImpl(request)
    }

    await botを接続する(env, fetchImpl)

    expect(登録した購読).toEqual([])
  })

  it('配信者のセッションが切れていたら、botのトークンを保存しない', async () => {
    const { env, store } = 環境を作る()
    const twitch = Twitchの代役('67890', { login: 'haishinsha_bot', scopes: BOT_SCOPES })
    const session = await 配信者のセッションクッキー(env)
    const login = await 呼び出す(new Request(`${サイト}/api/auth/login?role=bot`, { headers: { Cookie: session } }), env, twitch.fetchImpl)
    const state = new URL(login.headers.get('Location')!).searchParams.get('state')!
    const stateCookie = login.headers.getSetCookie()[0]!.split(';')[0]!

    // 認可画面にいる間にログアウトした（セッションのクッキーを付けずに戻ってきた）場合
    const response = await 呼び出す(
      new Request(`${サイト}/api/auth/callback?code=認可コード&state=${state}`, { headers: { Cookie: stateCookie } }),
      env,
      twitch.fetchImpl,
    )

    expect(response.status).toBe(401)
    expect(await loadToken(store, 'bot')).toBeNull()
  })
})

describe('GET /api/auth/callback', () => {
  it('配信者本人がログインすると、トークンを保存し、オーバーレイ用キーを発行し、セッションを開始する', async () => {
    const { env, store } = 環境を作る()
    const response = await ログインする(env, Twitchの代役(配信者のID).fetchImpl)

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/')
    expect(await loadToken(store, 'broadcaster')).toMatchObject({
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
    expect(await loadToken(store, 'broadcaster')).toBeNull()
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

  it('ログインすると、配信の記録のためのWebhook宛ての購読を登録する', async () => {
    const { env } = 環境を作る()
    const twitch = Twitchの代役(配信者のID)
    // fetch に渡した Request の本文は一度しか読めないので、送られた時点で控えておく
    const 登録した購読: { type: string; transport: unknown }[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      if (request.method === 'POST' && request.url === 'https://api.twitch.tv/helix/eventsub/subscriptions') {
        登録した購読.push((await request.clone().json()) as { type: string; transport: unknown })
      }
      return twitch.fetchImpl(request)
    }
    await ログインする(env, fetchImpl)

    // botを接続していない状態なので、チャットは購読しない
    expect(登録した購読.map((subscription) => subscription.type)).toEqual(webhookEventTypes())
    for (const subscription of 登録した購読) {
      expect(subscription.transport).toEqual({
        method: 'webhook',
        callback: `${サイト}/api/eventsub/webhook`,
        secret: 'テスト用のWebhookシークレット',
      })
    }
  })

  it('Webhook宛ての購読に失敗しても、ログインは続ける。失敗は収集の失敗として記録する（ログインできないと失敗の記録も読めないため）', async () => {
    const { env } = 環境を作る()
    const twitch = Twitchの代役(配信者のID)
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      if (request.method === 'POST' && request.url === 'https://api.twitch.tv/helix/eventsub/subscriptions') {
        return Response.json({ error: 'Forbidden', status: 403, message: 'subscription missing proper authorization' }, { status: 403 })
      }
      return twitch.fetchImpl(request)
    }
    const response = await ログインする(env, fetchImpl)

    expect(response.status).toBe(302)
    expect(await listFailures(env.DB)).toMatchObject([
      { code: 'webhook-subscription-failed', message: expect.stringContaining('subscription missing proper authorization') },
    ])
  })

  it('https でないサイト（ローカルの開発サーバー）では、Webhook宛ての購読を登録しない（Twitchが https のURLしか受け付けないため）', async () => {
    const { env } = 環境を作る()
    const twitch = Twitchの代役(配信者のID)
    const ローカル = 'http://localhost:5173'
    const login = await 呼び出す(new Request(`${ローカル}/api/auth/login`), env, twitch.fetchImpl)
    const state = new URL(login.headers.get('Location')!).searchParams.get('state')!
    const stateCookie = login.headers.getSetCookie()[0]!.split(';')[0]!
    const response = await 呼び出す(
      new Request(`${ローカル}/api/auth/callback?code=認可コード&state=${state}`, { headers: { Cookie: stateCookie } }),
      env,
      twitch.fetchImpl,
    )

    expect(response.status).toBe(302)
    expect(twitch.requests.filter((request) => request.url.includes('/helix/eventsub/subscriptions'))).toHaveLength(0)
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
    await saveToken(store, 'broadcaster', {
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
