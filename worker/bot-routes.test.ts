/**
 * チャットボットの管理用API（bot-routes.ts）のテスト
 *
 * KVとTwitchへの通信を差し替え、経路ごとの振る舞いを確認する。特に重要なのは次の3点。
 * - 配信者のセッションがなければ、botの状態を読むことも切断することもチャットを送ることもできないこと
 * - botのトークンそのものを応答に含めないこと
 * - 本文が空・長すぎる・botが未接続といった場合に、黙って何もせずエラーで伝えること
 */
import { describe, expect, it } from 'vitest'
import { BOT_SCOPES } from './eventsub'
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
    throw new Error(`テストで想定していない通信です: ${request.url}`)
  }
  return { 送信したチャット, fetchImpl }
}

const Twitchへは通信しない = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
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

    const response = await 呼び出す(await 配信者のリクエスト(env, '/api/admin/bot'), env)

    const body = await response.json()
    expect(body).toEqual({ bot: { userId: botのID, login: 'haishinsha_bot', missingScopes: [] } })
    expect(JSON.stringify(body)).not.toContain('bot-access-token')
  })

  it('スコープが足りなければ、不足しているスコープを示す（接続し直しが要ることを管理画面で伝えるため）', async () => {
    const { env, store } = 環境を作る()
    await saveToken(store, 'bot', botのトークン(['user:read:chat']))

    const response = await 呼び出す(await 配信者のリクエスト(env, '/api/admin/bot'), env)

    expect(await response.json()).toMatchObject({ bot: { missingScopes: ['user:bot', 'user:write:chat'] } })
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

    const response = await 呼び出す(await 配信者のリクエスト(env, '/api/admin/bot', { method: 'DELETE' }), env)

    expect(response.status).toBe(204)
    expect(await loadToken(store, 'bot')).toBeNull()
    expect(await loadToken(store, 'broadcaster')).not.toBeNull()
  })

  it('接続していなくても204を返す（切断を何度押しても同じ結果になるように）', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(await 配信者のリクエスト(env, '/api/admin/bot', { method: 'DELETE' }), env)

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
