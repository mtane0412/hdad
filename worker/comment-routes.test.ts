/**
 * コメントビューアーの経路（/api/admin/comments/*）のテスト
 *
 * 確かめるのは次の6点である。
 * - 配信者の画面からのWebSocketの接続が、配送先（Durable Object）へ引き渡されること
 * - ログインしていない接続・別のサイトから開かれた接続を断ること（WebSocketはGETなので、書き換えのときのCSRF対策が効かない）
 * - 発言した人のアイコンを、ユーザーIDからまとめて引けること
 * - 配信者が選んだ処分（削除・タイムアウト・BAN）を、botの権限で行えること
 * - 配信者本人としてチャットを送れること（許可を取り直す前は、botで代わりに送らず断ること）
 * - その配信で初めての発言に挨拶した・挨拶していない状態に戻したことを記録し、開いている画面へ知らせること
 */
import { describe, expect, it } from 'vitest'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeBucket } from './fake-bucket'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeTabChannel } from './fake-tab-channel'
import { createFakeStore } from './fake-store'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'
import { MANUAL_TIMEOUT_SECONDS } from './comment-routes'
import { saveToken } from './token'

const now = Date.parse('2026-09-29T09:00:00Z')
const broadcasterId = '12345'
const origin = 'https://hdad.example.com'

const createEnv = () => {
  const deliveryTarget = createFakeCommentChannel()
  const env = {
    STORE: createFakeStore(),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    ASSETS: createFakeAssets(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: broadcasterId,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: createFakeAlertChannel().namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: deliveryTarget.namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    AI: createFakeWorkersAi(),
  } satisfies Env
  return { env, deliveryTarget }
}

const noTwitchFetch = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

const noWait = async (): Promise<void> => {}

const noDefer = (): void => {
  throw new Error('このテストでは、応答のあとに続く処理を使いません')
}

const invoke = (request: Request, env: Env, fetchImpl: typeof fetch = noTwitchFetch) =>
  handleRequest(request, env, { fetch: fetchImpl, now: () => now, wait: noWait, waitUntil: noDefer })

/** 配信者としてログインした状態のクッキー */
const broadcasterCookie = async (env: Env): Promise<string> => `__Host-session=${await createSessionToken(broadcasterId, env.SESSION_SECRET, now)}`

describe('GET /api/admin/comments/socket', () => {
  /** ブラウザがWebSocketをつなぐときと同じヘッダーで呼ぶ */
  const connect = (env: Env, headers: Record<string, string> = {}) =>
    invoke(new Request(`${origin}/api/admin/comments/socket`, { headers: { Upgrade: 'websocket', Origin: origin, ...headers } }), env)

  it('配信者の接続を、配送先へ引き渡す', async () => {
    const { env, deliveryTarget } = createEnv()

    const response = await connect(env, { Cookie: await broadcasterCookie(env) })

    expect(response.status).toBe(200)
    expect(deliveryTarget.forwardedConnections).toHaveLength(1)
  })

  it('ログインしていない接続は断る', async () => {
    const { env, deliveryTarget } = createEnv()

    const response = await connect(env)

    expect(response.status).toBe(401)
    expect(deliveryTarget.forwardedConnections).toEqual([])
  })

  it('別のサイトから開かれた接続は断る（視聴者のチャットを他のサイトに読ませない）', async () => {
    const { env, deliveryTarget } = createEnv()

    const response = await connect(env, { Cookie: await broadcasterCookie(env), Origin: 'https://evil.example.com' })

    expect(response.status).toBe(403)
    expect(deliveryTarget.forwardedConnections).toEqual([])
  })

  it('WebSocketでない要求は断る', async () => {
    const { env } = createEnv()

    const response = await invoke(new Request(`${origin}/api/admin/comments/socket`, { headers: { Cookie: await broadcasterCookie(env), Origin: origin } }), env)

    expect(response.status).toBe(400)
  })
})

describe('GET /api/admin/comments/icons', () => {
  /** アプリアクセストークンの発行と、ユーザーの問い合わせに応える Twitch の代役 */
  const twitchReturningUsers = (users: { id: string; profile_image_url: string }[]) => {
    const requestedUrls: URL[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.href.startsWith('https://id.twitch.tv/oauth2/token')) return Response.json({ access_token: 'test-app-token', expires_in: 3600 })
      if (url.origin + url.pathname === 'https://api.twitch.tv/helix/users') {
        requestedUrls.push(url)
        return Response.json({ data: users })
      }
      throw new Error(`テストで想定していない通信です: ${request.url}`)
    }
    return { fetchImpl, requestedUrls }
  }

  const lookUpIcon = async (env: Env, query: string, fetchImpl?: typeof fetch) =>
    invoke(new Request(`${origin}/api/admin/comments/icons${query}`, { headers: { Cookie: await broadcasterCookie(env) } }), env, fetchImpl)

  it('ユーザーIDごとのアイコンのURLを返す', async () => {
    const { env } = createEnv()
    const { fetchImpl, requestedUrls } = twitchReturningUsers([{ id: '777', profile_image_url: 'https://static-cdn.jtvnw.net/jtv_user_pictures/jouren.png' }])

    const response = await lookUpIcon(env, '?user_id=777', fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ icons: { '777': 'https://static-cdn.jtvnw.net/jtv_user_pictures/jouren.png' } })
    expect(requestedUrls[0]?.searchParams.getAll('id')).toEqual(['777'])
  })

  it('ログインしていなければ断る', async () => {
    const { env } = createEnv()

    const response = await invoke(new Request(`${origin}/api/admin/comments/icons?user_id=777`), env)

    expect(response.status).toBe(401)
  })

  it('ユーザーIDが1つも無い・数字でない・100人を超える問い合わせは400にする（Twitchが1度に引けるのは100人まで）', async () => {
    const { env } = createEnv()
    const tooMany = Array.from({ length: 101 }, (_, index) => `user_id=${index + 1}`).join('&')

    for (const query of ['', '?user_id=じょうれん', `?${tooMany}`]) {
      const response = await lookUpIcon(env, query)
      expect(response.status).toBe(400)
    }
  })
})

describe('POST /api/admin/comments/moderation', () => {
  const botId = '67890'

  /** botを接続済みにした環境を作る */
  const envWithBotConnected = async () => {
    const created = createEnv()
    await saveToken(created.env.STORE, 'bot', {
      accessToken: 'bot-access-token',
      refreshToken: 'bot-refresh-token',
      expiresAt: now + 60 * 60 * 1000,
      scopes: ['user:bot', 'moderator:manage:banned_users', 'moderator:manage:chat_messages'],
      userId: botId,
      login: 'haishinsha_bot',
    })
    return created
  }

  /** 発言の削除とBANに応える Twitch の代役。呼ばれた操作を記録する */
  const twitchRespondingToModeration = () => {
    const calledOperations: { method: string; url: URL; body: unknown }[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.origin + url.pathname === 'https://api.twitch.tv/helix/moderation/chat' && request.method === 'DELETE') {
        calledOperations.push({ method: 'DELETE', url, body: null })
        return new Response(null, { status: 204 })
      }
      if (url.origin + url.pathname === 'https://api.twitch.tv/helix/moderation/bans' && request.method === 'POST') {
        calledOperations.push({ method: 'POST', url, body: await request.json() })
        return Response.json({ data: [{}] })
      }
      throw new Error(`テストで想定していない通信です: ${request.method} ${request.url}`)
    }
    return { fetchImpl, calledOperations }
  }

  const moderate = async (env: Env, body: unknown, fetchImpl?: typeof fetch, headers: Record<string, string> = {}) =>
    invoke(
      new Request(`${origin}/api/admin/comments/moderation`, {
        method: 'POST',
        headers: { Cookie: await broadcasterCookie(env), Origin: origin, 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      env,
      fetchImpl,
    )

  it('発言の削除は、botとしてその発言だけを消す', async () => {
    const { env } = await envWithBotConnected()
    const { fetchImpl, calledOperations } = twitchRespondingToModeration()

    const response = await moderate(env, { action: 'delete', messageId: '荒らしの発言', userId: '11111' }, fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ action: 'delete' })
    expect(calledOperations.map(({ method, url }) => [method, url.searchParams.get('moderator_id'), url.searchParams.get('message_id')])).toEqual([
      ['DELETE', botId, '荒らしの発言'],
    ])
  })

  it('タイムアウトは、Workerが決めた長さでbotとして行い、その長さを返す', async () => {
    const { env } = await envWithBotConnected()
    const { fetchImpl, calledOperations } = twitchRespondingToModeration()

    const response = await moderate(env, { action: 'timeout', messageId: '荒らしの発言', userId: '11111' }, fetchImpl)

    expect(await response.json()).toEqual({ action: 'timeout', durationSeconds: MANUAL_TIMEOUT_SECONDS })
    // Twitch はタイムアウトした人の発言をまとめて消すので、発言の削除は先に行わない
    expect(calledOperations.map(({ method }) => method)).toEqual(['POST'])
    expect(calledOperations[0]?.body).toMatchObject({ data: { user_id: '11111', duration: MANUAL_TIMEOUT_SECONDS } })
  })

  it('BANは、期限なしでbotとして行う', async () => {
    const { env } = await envWithBotConnected()
    const { fetchImpl, calledOperations } = twitchRespondingToModeration()

    const response = await moderate(env, { action: 'ban', messageId: '荒らしの発言', userId: '11111' }, fetchImpl)

    expect(await response.json()).toEqual({ action: 'ban' })
    expect(calledOperations[0]?.body).toMatchObject({ data: { user_id: '11111' } })
    expect((calledOperations[0]?.body as { data: Record<string, unknown> }).data.duration).toBeUndefined()
  })

  it('知らない操作・項目の欠けた本文は400にする', async () => {
    const { env } = await envWithBotConnected()

    for (const body of [{ action: 'kick', messageId: '発言', userId: '11111' }, { action: 'delete', userId: '11111' }, { action: 'ban', messageId: '発言' }]) {
      const response = await moderate(env, body)
      expect(response.status).toBe(400)
    }
  })

  it('botを接続していなければ、理由を添えて断る', async () => {
    const { env } = createEnv()

    const response = await moderate(env, { action: 'delete', messageId: '荒らしの発言', userId: '11111' })

    expect(response.status).toBe(401)
  })

  it('別のサイトから送られた処分は断る', async () => {
    const { env } = await envWithBotConnected()

    const response = await moderate(env, { action: 'ban', messageId: '荒らしの発言', userId: '11111' }, undefined, { Origin: 'https://evil.example.com' })

    expect(response.status).toBe(403)
  })
})

describe('POST /api/admin/comments/messages', () => {
  /** 配信者のトークンを保存した環境を作る。scopes を変えると、許可を取り直す前の状態を作れる */
  const envLoggedInAsBroadcaster = async (scopes: string[] = ['user:read:chat', 'user:write:chat']) => {
    const created = createEnv()
    await saveToken(created.env.STORE, 'broadcaster', {
      accessToken: 'broadcaster-access-token',
      refreshToken: 'broadcaster-refresh-token',
      expiresAt: now + 60 * 60 * 1000,
      scopes,
      userId: broadcasterId,
      login: 'haishinsha',
    })
    return created
  }

  /** チャットの送信に応える Twitch の代役。送られたリクエストを記録する */
  const twitchRespondingToSend = () => {
    const sent: { authorization: string | null; body: unknown }[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      if (request.url === 'https://api.twitch.tv/helix/chat/messages' && request.method === 'POST') {
        sent.push({ authorization: request.headers.get('Authorization'), body: await request.json() })
        return Response.json({ data: [{ message_id: '送った発言', is_sent: true }] })
      }
      throw new Error(`テストで想定していない通信です: ${request.method} ${request.url}`)
    }
    return { fetchImpl, sent }
  }

  const send = async (env: Env, body: unknown, fetchImpl?: typeof fetch, headers: Record<string, string> = {}) =>
    invoke(
      new Request(`${origin}/api/admin/comments/messages`, {
        method: 'POST',
        headers: { Cookie: await broadcasterCookie(env), Origin: origin, 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      env,
      fetchImpl,
    )

  it('配信者のトークンで、配信者本人としてチャットへ送る', async () => {
    const { env } = await envLoggedInAsBroadcaster()
    const { fetchImpl, sent } = twitchRespondingToSend()

    const response = await send(env, { message: 'みなさん来てくれてありがとう' }, fetchImpl)

    expect(response.status).toBe(204)
    expect(sent).toEqual([
      {
        authorization: 'Bearer broadcaster-access-token',
        body: { broadcaster_id: broadcasterId, sender_id: broadcasterId, message: 'みなさん来てくれてありがとう' },
      },
    ])
  })

  it('配信者がまだ user:write:chat を許可していなければ、botで送らずにログインし直すよう伝える', async () => {
    const { env } = await envLoggedInAsBroadcaster(['user:read:chat'])

    const response = await send(env, { message: 'みなさん来てくれてありがとう' })

    expect(response.status).toBe(401)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('missing-scope')
    expect(body.error.message).toContain('ログインし直してください')
  })

  it('空の文言・500文字を超える文言は400にする', async () => {
    const { env } = await envLoggedInAsBroadcaster()

    for (const message of ['', '   ', 'あ'.repeat(501)]) {
      const response = await send(env, { message })
      expect(response.status).toBe(400)
    }
  })

  it('別のサイトから送られたものは断る', async () => {
    const { env } = await envLoggedInAsBroadcaster()

    const response = await send(env, { message: 'みなさん来てくれてありがとう' }, undefined, { Origin: 'https://evil.example.com' })

    expect(response.status).toBe(403)
  })
})

describe('POST /api/admin/comments/greetings', () => {
  const toggle = async (env: Env, body: unknown, headers: Record<string, string> = {}) =>
    invoke(
      new Request(`${origin}/api/admin/comments/greetings`, {
        method: 'POST',
        headers: { Cookie: await broadcasterCookie(env), Origin: origin, 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      env,
    )

  /** 配信中にして、たなかさんのその配信で初めての発言を記録しておく（Webhook が記録するのと同じ形） */
  const envWithFirstChat = () => {
    const created = createEnv()
    created.env.DB.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
      .run('haishin-1', new Date(now - 60_000).toISOString(), '朝配信', 'Just Chatting')
    created.env.DB.sqlite
      .prepare('INSERT INTO first_chatters (session_id, chatter_user_id, message_id, first_chatted_at) VALUES (?, ?, ?, ?)')
      .run('haishin-1', '11111', 'たなかさんの初見の挨拶', new Date(now - 30_000).toISOString())
    return created
  }

  /** 挨拶した時刻の記録をそのまま読む */
  const greetedAt = (env: ReturnType<typeof createEnv>['env']) => env.DB.sqlite.prepare('SELECT message_id, greeted_at FROM first_chatters').all()

  it('挨拶したことを記録し、開いている画面へ知らせる', async () => {
    const { env, deliveryTarget } = envWithFirstChat()

    const response = await toggle(env, { messageId: 'たなかさんの初見の挨拶', greeted: true })

    expect(response.status).toBe(204)
    expect(greetedAt(env)).toEqual([{ message_id: 'たなかさんの初見の挨拶', greeted_at: new Date(now).toISOString() }])
    // 画面は届いた順に当てはめるので、付け替えるたびに別の通知として見分けられるIDを振る
    expect(deliveryTarget.pushedItems).toEqual([{ kind: 'greeting', id: expect.any(String), at: now, messageId: 'たなかさんの初見の挨拶', greeted: true }])
  })

  it('挨拶していない状態に戻したことも記録し、知らせる', async () => {
    const { env, deliveryTarget } = envWithFirstChat()
    await toggle(env, { messageId: 'たなかさんの初見の挨拶', greeted: true })

    await toggle(env, { messageId: 'たなかさんの初見の挨拶', greeted: false })

    expect(greetedAt(env)).toEqual([{ message_id: 'たなかさんの初見の挨拶', greeted_at: null }])
    expect(deliveryTarget.pushedItems.map((item) => item.kind === 'greeting' && item.greeted)).toEqual([true, false])
    // 付け替えの通知は、1回ごとに違うIDを持つ（同じIDだと、画面が2回目を「当てはめ済み」として捨ててしまう）
    expect(new Set(deliveryTarget.pushedItems.map((item) => item.id)).size).toBe(2)
  })

  it('その配信で初めての発言として記録されていない発言なら、404で断り知らせもしない', async () => {
    const { env, deliveryTarget } = envWithFirstChat()

    const response = await toggle(env, { messageId: 'たなかさんの2回目の発言', greeted: true })

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'unknown-first-chat' } })
    expect(deliveryTarget.pushedItems).toEqual([])
  })

  it.each([
    ['発言のIDが無い', { greeted: true }],
    ['発言のIDが空', { messageId: '', greeted: true }],
    ['挨拶したかどうかが真偽値でない', { messageId: 'たなかさんの初見の挨拶', greeted: 'はい' }],
  ])('%s本文は400で断り、記録も知らせもしない', async (_description, body) => {
    const { env, deliveryTarget } = envWithFirstChat()

    const response = await toggle(env, body)

    expect(response.status).toBe(400)
    expect(greetedAt(env)).toEqual([{ message_id: 'たなかさんの初見の挨拶', greeted_at: null }])
    expect(deliveryTarget.pushedItems).toEqual([])
  })

  it('ログインしていなければ断る', async () => {
    const { env } = envWithFirstChat()

    const response = await toggle(env, { messageId: 'たなかさんの初見の挨拶', greeted: true }, { Cookie: '' })

    expect(response.status).toBe(401)
    expect(greetedAt(env)).toEqual([{ message_id: 'たなかさんの初見の挨拶', greeted_at: null }])
  })

  it('画面へ知らせられなければ、成功として返さない（付け替えが画面に出ないことに気づけるようにする）', async () => {
    const { env } = envWithFirstChat()
    const failingDeliveryTarget = createFakeCommentChannel({ shouldFail: true })

    const response = await toggle({ ...env, COMMENTS: failingDeliveryTarget.namespace }, { messageId: 'たなかさんの初見の挨拶', greeted: true })

    expect(response.ok).toBe(false)
  })
})
