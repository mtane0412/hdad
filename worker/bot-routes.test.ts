/**
 * チャットボットの管理用API（bot-routes.ts）のテスト
 *
 * KVとTwitchへの通信を差し替え、経路ごとの振る舞いを確認する。特に重要なのは次の3点。
 * - 配信者のセッションがなければ、botの状態を読むことも切断することもチャットを送ることもできないこと
 * - botのトークンそのものを応答に含めないこと
 * - 本文が空・長すぎる・botが未接続といった場合に、黙って何もせずエラーで伝えること
 */
import { describe, expect, it } from 'vitest'
import { BOT_SCOPES, REQUIRED_SCOPES } from './eventsub'
import { createFakeBucket } from './fake-bucket'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'
import { loadToken, saveToken, type StoredToken } from './token'

const 現在時刻 = Date.UTC(2026, 8, 21, 12, 0, 0)
const 配信者のID = '12345'
const botのID = '67890'
const サイト = 'https://stream-assets.example.com'
/** Twitchが決めているチャット本文の上限 */
const 本文の上限 = 500

const botのトークン = (scopes: readonly string[] = BOT_SCOPES): StoredToken => ({
  accessToken: 'bot-access-token',
  refreshToken: 'bot-refresh-token',
  expiresAt: 現在時刻 + 60 * 60 * 1000,
  scopes: [...scopes],
  userId: botのID,
  login: 'haishinsha_bot',
})

const 配信者のトークン = (scopes: readonly string[] = REQUIRED_SCOPES): StoredToken => ({
  accessToken: 'broadcaster-access-token',
  refreshToken: 'broadcaster-refresh-token',
  expiresAt: 現在時刻 + 60 * 60 * 1000,
  scopes: [...scopes],
  userId: 配信者のID,
  login: 'haishinsha',
})

/**
 * モデレーターの一覧の問い合わせに応える。botがモデレーターかどうかを、接続状態と一緒に返すために呼ばれる。
 * 当てはまらないリクエストには null を返す。
 */
const モデレーターの問い合わせに応える = (request: Request, モデレーターである: boolean): Response | null => {
  if (!request.url.startsWith('https://api.twitch.tv/helix/moderation/moderators')) return null
  const data = モデレーターである ? [{ user_id: botのID, user_login: 'haishinsha_bot', user_name: 'haishinsha_bot' }] : []
  return Response.json({ data, pagination: {} })
}

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

/** Twitchの代わりに応答する fetch。チャット送信に来たリクエストを控える */
const Twitchの代役 = (chatResponse: Response = Response.json({ data: [{ message_id: 'abc', is_sent: true }] })) => {
  const 送信したチャット: Request[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    if (request.url === 'https://api.twitch.tv/helix/chat/messages') {
      送信したチャット.push(request.clone())
      return chatResponse.clone()
    }
    const 購読 = 購読の問い合わせに応える(request)
    if (購読) return 購読
    throw new Error(`テストで想定していない通信です: ${request.url}`)
  }
  return { 送信したチャット, fetchImpl }
}

const Twitchへは通信しない = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

/**
 * Webhook宛ての購読を揃える処理が使う通信に応える。
 * botの接続・切断のたびに購読を揃え直すので、どの代役もこれを通す必要がある。
 * 当てはまらないリクエストには null を返し、呼び出し側に任せる。
 */
const 購読の問い合わせに応える = (request: Request): Response | null => {
  if (request.url === 'https://id.twitch.tv/oauth2/token') return Response.json({ access_token: 'test-app-token' })
  if (request.url.startsWith('https://api.twitch.tv/helix/eventsub/subscriptions')) {
    return request.method === 'GET' ? Response.json({ data: [] }) : Response.json({ data: [] }, { status: 202 })
  }
  return null
}

const 呼び出す = (request: Request, env: Env, fetchImpl: typeof fetch = Twitchへは通信しない) =>
  handleRequest(request, env, { fetch: fetchImpl, now: () => 現在時刻 })

/** 配信者としてログイン済みのリクエストを作る。書き換えを伴うメソッドには、ブラウザと同じく Origin を付ける */
const 配信者のリクエスト = async (env: Env, path: string, init: RequestInit = {}): Promise<Request> => {
  const session = await createSessionToken(配信者のID, env.SESSION_SECRET, 現在時刻)
  const headers = new Headers(init.headers)
  headers.set('Cookie', `__Host-session=${session}`)
  if (init.method && init.method !== 'GET' && !headers.has('Origin')) headers.set('Origin', サイト)
  return new Request(`${サイト}${path}`, { ...init, headers })
}

const エラーコード = async (response: Response): Promise<unknown> => {
  const body = (await response.json()) as { error?: { code?: unknown } }
  return body.error?.code
}

describe('GET /api/admin/bot', () => {
  it('セッションがなければ401を返す', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(new Request(`${サイト}/api/admin/bot`), env)

    expect(response.status).toBe(401)
    expect(await エラーコード(response)).toBe('unauthorized')
  })

  it('botを接続していなければ bot は null を返す', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(await 配信者のリクエスト(env, '/api/admin/bot'), env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ bot: null })
  })

  it('接続済みなら、ログイン名とユーザーIDを返す。トークンは返さない', async () => {
    const { env, store } = 環境を作る()
    await saveToken(store, 'bot', botのトークン())
    await saveToken(store, 'broadcaster', 配信者のトークン())

    const response = await 呼び出す(await 配信者のリクエスト(env, '/api/admin/bot'), env, async (input, init) => {
      const モデレーター = モデレーターの問い合わせに応える(new Request(input, init), true)
      if (モデレーター) return モデレーター
      throw new Error(`テストで想定していない通信です: ${String(input)}`)
    })

    const body = await response.json()
    expect(body).toEqual({ bot: { userId: botのID, login: 'haishinsha_bot', missingScopes: [], isModerator: true } })
    expect(JSON.stringify(body)).not.toContain('bot-access-token')
  })

  it('botがモデレーターにされていなければ isModerator は false になる（管理画面で /mod を促すため）', async () => {
    const { env, store } = 環境を作る()
    await saveToken(store, 'bot', botのトークン())
    await saveToken(store, 'broadcaster', 配信者のトークン())

    const response = await 呼び出す(await 配信者のリクエスト(env, '/api/admin/bot'), env, async (input, init) => {
      const モデレーター = モデレーターの問い合わせに応える(new Request(input, init), false)
      if (モデレーター) return モデレーター
      throw new Error(`テストで想定していない通信です: ${String(input)}`)
    })

    expect(await response.json()).toMatchObject({ bot: { isModerator: false } })
  })

  it('配信者のトークンに moderation:read が無ければ、黙ってfalseにせずエラーで伝える', async () => {
    const { env, store } = 環境を作る()
    await saveToken(store, 'bot', botのトークン())
    await saveToken(store, 'broadcaster', 配信者のトークン(REQUIRED_SCOPES.filter((scope) => scope !== 'moderation:read')))

    const response = await 呼び出す(await 配信者のリクエスト(env, '/api/admin/bot'), env)

    // 不足スコープは配信者のログインし直しでしか解決しないので、401（AuthError）で返す
    expect(response.status).toBe(401)
    expect(await エラーコード(response)).toBe('missing-scope')
  })

  it('スコープが足りなければ、不足しているスコープを示す（接続し直しが要ることを管理画面で伝えるため）', async () => {
    const { env, store } = 環境を作る()
    await saveToken(store, 'bot', botのトークン(['user:read:chat']))
    await saveToken(store, 'broadcaster', 配信者のトークン())

    const response = await 呼び出す(await 配信者のリクエスト(env, '/api/admin/bot'), env, async (input, init) => {
      const モデレーター = モデレーターの問い合わせに応える(new Request(input, init), true)
      if (モデレーター) return モデレーター
      throw new Error(`テストで想定していない通信です: ${String(input)}`)
    })

    expect(await response.json()).toMatchObject({
      bot: {
        missingScopes: [
          'user:bot',
          'user:write:chat',
          'moderator:manage:banned_users',
          'moderator:manage:chat_messages',
          'moderator:manage:announcements',
        ],
      },
    })
  })
})

describe('DELETE /api/admin/bot', () => {
  it('セッションがなければ401を返し、トークンを消さない', async () => {
    const { env, store } = 環境を作る()
    await saveToken(store, 'bot', botのトークン())

    const response = await 呼び出す(new Request(`${サイト}/api/admin/bot`, { method: 'DELETE' }), env)

    expect(response.status).toBe(401)
    expect(await loadToken(store, 'bot')).not.toBeNull()
  })

  it('botのトークンを消す。配信者のトークンには触れない', async () => {
    const { env, store } = 環境を作る()
    await saveToken(store, 'bot', botのトークン())
    await saveToken(store, 'broadcaster', { ...botのトークン(), userId: 配信者のID, login: 'haishinsha' })

    const response = await 呼び出す(await 配信者のリクエスト(env, '/api/admin/bot', { method: 'DELETE' }), env, Twitchの代役().fetchImpl)

    expect(response.status).toBe(204)
    expect(await loadToken(store, 'bot')).toBeNull()
    expect(await loadToken(store, 'broadcaster')).not.toBeNull()
  })

  it('接続していなくても204を返す（切断を何度押しても同じ結果になるように）', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(await 配信者のリクエスト(env, '/api/admin/bot', { method: 'DELETE' }), env, Twitchの代役().fetchImpl)

    expect(response.status).toBe(204)
  })
})

describe('POST /api/admin/bot/messages', () => {
  const 送信する = async (env: Env, message: unknown, fetchImpl: typeof fetch) =>
    呼び出す(
      await 配信者のリクエスト(env, '/api/admin/bot/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      }),
      env,
      fetchImpl,
    )

  it('セッションがなければ401を返し、Twitchへは送らない', async () => {
    const { env, store } = 環境を作る()
    await saveToken(store, 'bot', botのトークン())
    const twitch = Twitchの代役()

    const response = await 呼び出す(
      new Request(`${サイト}/api/admin/bot/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: サイト },
        body: JSON.stringify({ message: '勝手に送られたメッセージ' }),
      }),
      env,
      twitch.fetchImpl,
    )

    expect(response.status).toBe(401)
    expect(twitch.送信したチャット).toHaveLength(0)
  })

  it('botの名前で、配信者のチャンネルへメッセージを送る', async () => {
    const { env, store } = 環境を作る()
    await saveToken(store, 'bot', botのトークン())
    const twitch = Twitchの代役()

    const response = await 送信する(env, 'こんばんは、配信が始まりました', twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(await twitch.送信したチャット[0]!.json()).toEqual({
      broadcaster_id: 配信者のID,
      sender_id: botのID,
      message: 'こんばんは、配信が始まりました',
    })
  })

  it('botを接続していなければ、接続を促すエラーになる', async () => {
    const { env } = 環境を作る()
    const twitch = Twitchの代役()

    const response = await 送信する(env, 'こんばんは', twitch.fetchImpl)

    expect(response.status).toBe(401)
    expect(await エラーコード(response)).toBe('not-logged-in')
    expect(twitch.送信したチャット).toHaveLength(0)
  })

  it('本文が空なら、Twitchへ送らずに400で拒否する', async () => {
    const { env, store } = 環境を作る()
    await saveToken(store, 'bot', botのトークン())
    const twitch = Twitchの代役()

    const response = await 送信する(env, '   ', twitch.fetchImpl)

    expect(response.status).toBe(400)
    expect(await エラーコード(response)).toBe('invalid-message')
    expect(twitch.送信したチャット).toHaveLength(0)
  })

  it('本文が500文字を超えるなら、Twitchへ送らずに400で拒否する', async () => {
    const { env, store } = 環境を作る()
    await saveToken(store, 'bot', botのトークン())
    const twitch = Twitchの代役()

    const response = await 送信する(env, 'あ'.repeat(本文の上限 + 1), twitch.fetchImpl)

    expect(response.status).toBe(400)
    expect(await エラーコード(response)).toBe('invalid-message')
    expect(twitch.送信したチャット).toHaveLength(0)
  })

  it('本文が文字列でなければ400で拒否する', async () => {
    const { env, store } = 環境を作る()
    await saveToken(store, 'bot', botのトークン())
    const twitch = Twitchの代役()

    const response = await 送信する(env, 42, twitch.fetchImpl)

    expect(response.status).toBe(400)
    expect(await エラーコード(response)).toBe('invalid-message')
  })

  it('Twitchが受け取ったうえで送信しなかった場合（AutoModの保留など）は、成功扱いにしない', async () => {
    const { env, store } = 環境を作る()
    await saveToken(store, 'bot', botのトークン())
    const twitch = Twitchの代役(
      Response.json({
        data: [{ message_id: '', is_sent: false, drop_reason: { code: 'msg_rejected', message: 'メッセージがAutoModに保留されました' } }],
      }),
    )

    const response = await 送信する(env, 'あやしい文言', twitch.fetchImpl)

    expect(response.status).toBe(502)
    expect(await エラーコード(response)).toBe('twitch-error')
  })
})

describe('POST /api/admin/bot/device-code', () => {
  /** デバイスコードの発行に応える Twitch の代役 */
  const デバイスコードを発行するTwitch = () => {
    const requests: Request[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      requests.push(request.clone())
      if (request.url === 'https://id.twitch.tv/oauth2/device') {
        return Response.json({
          device_code: 'device-code-0123456789',
          user_code: 'ABCDEFGH',
          verification_uri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH',
          expires_in: 1800,
          interval: 5,
        })
      }
      throw new Error(`テストで想定していない通信です: ${request.url}`)
    }
    return { requests, fetchImpl }
  }

  it('セッションがなければ401を返し、Twitchへは問い合わせない', async () => {
    const { env } = 環境を作る()
    const twitch = デバイスコードを発行するTwitch()

    const response = await 呼び出す(
      new Request(`${サイト}/api/admin/bot/device-code`, { method: 'POST', headers: { Origin: サイト } }),
      env,
      twitch.fetchImpl,
    )

    expect(response.status).toBe(401)
    expect(twitch.requests).toHaveLength(0)
  })

  it('利用者に見せるコードと案内先を返す', async () => {
    const { env } = 環境を作る()
    const twitch = デバイスコードを発行するTwitch()

    const response = await 呼び出す(await 配信者のリクエスト(env, '/api/admin/bot/device-code', { method: 'POST' }), env, twitch.fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      deviceCode: 'device-code-0123456789',
      userCode: 'ABCDEFGH',
      verificationUri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH',
      expiresIn: 1800,
      intervalSeconds: 5,
    })
  })

  it('botに必要なスコープを指定して発行を求める', async () => {
    const { env } = 環境を作る()
    const twitch = デバイスコードを発行するTwitch()

    await 呼び出す(await 配信者のリクエスト(env, '/api/admin/bot/device-code', { method: 'POST' }), env, twitch.fetchImpl)

    const form = new URLSearchParams(await twitch.requests[0]!.text())
    expect(form.get('scopes')).toBe(BOT_SCOPES.join(' '))
  })
})

describe('POST /api/admin/bot/device-token', () => {
  /** デバイスコードの交換に、決めた応答を返す Twitch の代役 */
  const 交換に応えるTwitch = (tokenResponse: Response) => {
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = new Request(input, init)
      // デバイスコードの交換と、購読を揃えるときのアプリアクセストークンの発行は、どちらも同じURLを使う。
      // 交換は本文に device_code を含むので、それで見分ける
      const body = request.method === 'POST' ? await request.clone().text() : ''
      if (request.url === 'https://id.twitch.tv/oauth2/token' && body.includes('device_code')) return tokenResponse.clone()
      if (request.url === 'https://id.twitch.tv/oauth2/validate') {
        return Response.json({ user_id: botのID, login: 'haishinsha_bot', scopes: BOT_SCOPES })
      }
      const 購読 = 購読の問い合わせに応える(request)
      if (購読) return 購読
      // 接続できた時点で、botがモデレーターにされているかも確かめる
      const モデレーター = モデレーターの問い合わせに応える(request, true)
      if (モデレーター) return モデレーター
      throw new Error(`テストで想定していない通信です: ${request.url}`)
    }
    return { fetchImpl }
  }

  const 認可済みの応答 = () =>
    Response.json({ access_token: 'bot-access-token', refresh_token: 'bot-refresh-token', expires_in: 14400 })

  /** 本文をそのまま指定して交換を求める。既定では正しい形の本文を送る */
  const 交換する = async (env: Env, fetchImpl: typeof fetch, body: unknown = { deviceCode: 'device-code-0123456789' }) =>
    呼び出す(
      await 配信者のリクエスト(env, '/api/admin/bot/device-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
      fetchImpl,
    )

  it('セッションがなければ401を返し、トークンを保存しない', async () => {
    const { env, store } = 環境を作る()
    const twitch = 交換に応えるTwitch(認可済みの応答())

    const response = await 呼び出す(
      new Request(`${サイト}/api/admin/bot/device-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: サイト },
        body: JSON.stringify({ deviceCode: 'device-code-0123456789' }),
      }),
      env,
      twitch.fetchImpl,
    )

    expect(response.status).toBe(401)
    expect(await loadToken(store, 'bot')).toBeNull()
  })

  it('利用者がまだ認可していなければ、待っている状態を返す（エラーにしない）', async () => {
    const { env, store } = 環境を作る()
    const twitch = 交換に応えるTwitch(Response.json({ status: 400, message: 'authorization_pending' }, { status: 400 }))

    const response = await 交換する(env, twitch.fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'pending' })
    expect(await loadToken(store, 'bot')).toBeNull()
  })

  it('問い合わせが速すぎると言われたら、間隔を延ばして待つよう伝える（エラーにしない）', async () => {
    const { env, store } = 環境を作る()
    const twitch = 交換に応えるTwitch(Response.json({ status: 400, message: 'slow_down' }, { status: 400 }))

    const response = await 交換する(env, twitch.fetchImpl)

    expect(response.status).toBe(200)
    // 管理画面が間隔を延ばせるよう、pending とは区別して返す
    expect(await response.json()).toEqual({ status: 'slow-down' })
    expect(await loadToken(store, 'bot')).toBeNull()
  })

  it('認可が済んでいれば、botのトークンを保存して接続状態を返す', async () => {
    const { env, store } = 環境を作る()
    // モデレーターかどうかの確認には配信者のトークンが要る
    await saveToken(store, 'broadcaster', 配信者のトークン())
    const twitch = 交換に応えるTwitch(認可済みの応答())

    const response = await 交換する(env, twitch.fetchImpl)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ status: 'connected', bot: { userId: botのID, login: 'haishinsha_bot', missingScopes: [], isModerator: true } })
    // トークンはWorkerの中に留め、ブラウザへ返さない
    expect(JSON.stringify(body)).not.toContain('bot-access-token')
    expect(await loadToken(store, 'bot')).toMatchObject({ accessToken: 'bot-access-token', userId: botのID, login: 'haishinsha_bot' })
  })

  it('コードの期限が切れていたら、待ち続けずにエラーを返す', async () => {
    const { env } = 環境を作る()
    const twitch = 交換に応えるTwitch(Response.json({ status: 400, message: 'expired_token' }, { status: 400 }))

    const response = await 交換する(env, twitch.fetchImpl)

    expect(response.status).toBe(502)
    expect(await エラーコード(response)).toBe('twitch-error')
  })

  it('deviceCode がなければ、Twitchへ問い合わせずに400で拒否する', async () => {
    const { env } = 環境を作る()
    const twitch = 交換に応えるTwitch(認可済みの応答())

    const response = await 交換する(env, twitch.fetchImpl, {})

    expect(response.status).toBe(400)
    expect(await エラーコード(response)).toBe('invalid-device-code')
  })
})

describe('GET・PUT /api/admin/bot/commands', () => {
  const 挨拶のコマンド = { name: 'aisatsu', reply: '@{user} こんばんは', cooldownSeconds: 10 }

  const 保存する = async (env: Env, body: unknown) =>
    呼び出す(
      await 配信者のリクエスト(env, '/api/admin/bot/commands', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
    )

  it('セッションがなければ401を返す', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(new Request(`${サイト}/api/admin/bot/commands`), env)

    expect(response.status).toBe(401)
    expect(await エラーコード(response)).toBe('unauthorized')
  })

  it('まだ保存していなければ、空の一覧を返す', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(await 配信者のリクエスト(env, '/api/admin/bot/commands'), env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ commands: [] })
  })

  it('保存したコマンドを読み出せる', async () => {
    const { env } = 環境を作る()
    await 保存する(env, { commands: [挨拶のコマンド] })

    const response = await 呼び出す(await 配信者のリクエスト(env, '/api/admin/bot/commands'), env)

    expect(await response.json()).toEqual({ commands: [挨拶のコマンド] })
  })

  it('セッションがなければ保存できない', async () => {
    const { env, store } = 環境を作る()
    const response = await 呼び出す(
      new Request(`${サイト}/api/admin/bot/commands`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Origin: サイト },
        body: JSON.stringify({ commands: [挨拶のコマンド] }),
      }),
      env,
    )

    expect(response.status).toBe(401)
    expect(await store.get('bot-commands')).toBeNull()
  })

  it('内容に問題があれば、保存せずに問題点の一覧を返す', async () => {
    const { env, store } = 環境を作る()

    const response = await 保存する(env, { commands: [{ name: '', reply: '', cooldownSeconds: -1 }] })

    expect(response.status).toBe(400)
    // 応答の本文は一度しか読めないので、まとめて取り出してから確かめる
    const body = (await response.json()) as { error: { code: string; problems: string[] } }
    expect(body.error.code).toBe('invalid-config')
    // 問題点は最初の1件で止めず、すべて返す（管理画面で一度に直せるようにするため）
    expect(body.error.problems).toHaveLength(3)
    expect(await store.get('bot-commands')).toBeNull()
  })
})
