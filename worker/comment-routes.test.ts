/**
 * コメントビューアーの経路（/api/admin/comments/*）のテスト
 *
 * 確かめるのは次の7点である。
 * - 配信者の画面からのWebSocketの接続が、配送先（Durable Object）へ引き渡されること
 * - ログインしていない接続・別のサイトから開かれた接続を断ること（WebSocketはGETなので、書き換えのときのCSRF対策が効かない）
 * - 発言した人のアイコンを、ユーザーIDからまとめて引けること
 * - 配信者が選んだ処分（削除・タイムアウト・BAN）を、botの権限で行えること
 * - 配信者本人としてチャットを送れること（許可を取り直す前は、botで代わりに送らず断ること）
 * - 発言を既読にした・未読に戻したことを記録し、開いている画面へ知らせること
 * - コメントビューアーの設定（しばらく未読の発言を目立たせるか）を読み書きできること
 */
import { describe, expect, it } from 'vitest'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeBucket } from './fake-bucket'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeStore } from './fake-store'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'
import { MANUAL_TIMEOUT_SECONDS } from './comment-routes'
import { saveToken } from './token'

const 現在時刻 = Date.parse('2026-09-29T09:00:00Z')
const 配信者のID = '12345'
const サイト = 'https://hdad.example.com'

const 環境を作る = () => {
  const 配送先 = createFakeCommentChannel()
  const env = {
    STORE: createFakeStore(),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: 配信者のID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: createFakeAlertChannel().namespace,
    DRAW: createFakeDrawChannel().namespace,
    COMMENTS: 配送先.namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    AI: createFakeWorkersAi(),
  } satisfies Env
  return { env, 配送先 }
}

const Twitchへは通信しない = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

const 待たない = async (): Promise<void> => {}

const 後回しにしない = (): void => {
  throw new Error('このテストでは、応答のあとに続く処理を使いません')
}

const 呼び出す = (request: Request, env: Env, fetchImpl: typeof fetch = Twitchへは通信しない) =>
  handleRequest(request, env, { fetch: fetchImpl, now: () => 現在時刻, wait: 待たない, waitUntil: 後回しにしない })

/** 配信者としてログインした状態のクッキー */
const 配信者のクッキー = async (env: Env): Promise<string> => `__Host-session=${await createSessionToken(配信者のID, env.SESSION_SECRET, 現在時刻)}`

describe('GET /api/admin/comments/socket', () => {
  /** ブラウザがWebSocketをつなぐときと同じヘッダーで呼ぶ */
  const つなぐ = (env: Env, headers: Record<string, string> = {}) =>
    呼び出す(new Request(`${サイト}/api/admin/comments/socket`, { headers: { Upgrade: 'websocket', Origin: サイト, ...headers } }), env)

  it('配信者の接続を、配送先へ引き渡す', async () => {
    const { env, 配送先 } = 環境を作る()

    const response = await つなぐ(env, { Cookie: await 配信者のクッキー(env) })

    expect(response.status).toBe(200)
    expect(配送先.引き渡された接続).toHaveLength(1)
  })

  it('ログインしていない接続は断る', async () => {
    const { env, 配送先 } = 環境を作る()

    const response = await つなぐ(env)

    expect(response.status).toBe(401)
    expect(配送先.引き渡された接続).toEqual([])
  })

  it('別のサイトから開かれた接続は断る（視聴者のチャットを他のサイトに読ませない）', async () => {
    const { env, 配送先 } = 環境を作る()

    const response = await つなぐ(env, { Cookie: await 配信者のクッキー(env), Origin: 'https://evil.example.com' })

    expect(response.status).toBe(403)
    expect(配送先.引き渡された接続).toEqual([])
  })

  it('WebSocketでない要求は断る', async () => {
    const { env } = 環境を作る()

    const response = await 呼び出す(new Request(`${サイト}/api/admin/comments/socket`, { headers: { Cookie: await 配信者のクッキー(env), Origin: サイト } }), env)

    expect(response.status).toBe(400)
  })
})

describe('GET /api/admin/comments/icons', () => {
  /** アプリアクセストークンの発行と、ユーザーの問い合わせに応える Twitch の代役 */
  const ユーザーを返すTwitch = (users: { id: string; profile_image_url: string }[]) => {
    const 問い合わせたURL: URL[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.href.startsWith('https://id.twitch.tv/oauth2/token')) return Response.json({ access_token: 'test-app-token', expires_in: 3600 })
      if (url.origin + url.pathname === 'https://api.twitch.tv/helix/users') {
        問い合わせたURL.push(url)
        return Response.json({ data: users })
      }
      throw new Error(`テストで想定していない通信です: ${request.url}`)
    }
    return { fetchImpl, 問い合わせたURL }
  }

  const アイコンを引く = async (env: Env, query: string, fetchImpl?: typeof fetch) =>
    呼び出す(new Request(`${サイト}/api/admin/comments/icons${query}`, { headers: { Cookie: await 配信者のクッキー(env) } }), env, fetchImpl)

  it('ユーザーIDごとのアイコンのURLを返す', async () => {
    const { env } = 環境を作る()
    const { fetchImpl, 問い合わせたURL } = ユーザーを返すTwitch([{ id: '777', profile_image_url: 'https://static-cdn.jtvnw.net/jtv_user_pictures/jouren.png' }])

    const response = await アイコンを引く(env, '?user_id=777', fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ icons: { '777': 'https://static-cdn.jtvnw.net/jtv_user_pictures/jouren.png' } })
    expect(問い合わせたURL[0]?.searchParams.getAll('id')).toEqual(['777'])
  })

  it('ログインしていなければ断る', async () => {
    const { env } = 環境を作る()

    const response = await 呼び出す(new Request(`${サイト}/api/admin/comments/icons?user_id=777`), env)

    expect(response.status).toBe(401)
  })

  it('ユーザーIDが1つも無い・数字でない・100人を超える問い合わせは400にする（Twitchが1度に引けるのは100人まで）', async () => {
    const { env } = 環境を作る()
    const 多すぎる = Array.from({ length: 101 }, (_, 番号) => `user_id=${番号 + 1}`).join('&')

    for (const query of ['', '?user_id=じょうれん', `?${多すぎる}`]) {
      const response = await アイコンを引く(env, query)
      expect(response.status).toBe(400)
    }
  })
})

describe('POST /api/admin/comments/moderation', () => {
  const botのID = '67890'

  /** botを接続済みにした環境を作る */
  const bot接続済みの環境 = async () => {
    const 作ったもの = 環境を作る()
    await saveToken(作ったもの.env.STORE, 'bot', {
      accessToken: 'bot-access-token',
      refreshToken: 'bot-refresh-token',
      expiresAt: 現在時刻 + 60 * 60 * 1000,
      scopes: ['user:bot', 'moderator:manage:banned_users', 'moderator:manage:chat_messages'],
      userId: botのID,
      login: 'haishinsha_bot',
    })
    return 作ったもの
  }

  /** 発言の削除とBANに応える Twitch の代役。呼ばれた操作を記録する */
  const 処分に応えるTwitch = () => {
    const 呼ばれた操作: { method: string; url: URL; body: unknown }[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.origin + url.pathname === 'https://api.twitch.tv/helix/moderation/chat' && request.method === 'DELETE') {
        呼ばれた操作.push({ method: 'DELETE', url, body: null })
        return new Response(null, { status: 204 })
      }
      if (url.origin + url.pathname === 'https://api.twitch.tv/helix/moderation/bans' && request.method === 'POST') {
        呼ばれた操作.push({ method: 'POST', url, body: await request.json() })
        return Response.json({ data: [{}] })
      }
      throw new Error(`テストで想定していない通信です: ${request.method} ${request.url}`)
    }
    return { fetchImpl, 呼ばれた操作 }
  }

  const 処分する = async (env: Env, body: unknown, fetchImpl?: typeof fetch, headers: Record<string, string> = {}) =>
    呼び出す(
      new Request(`${サイト}/api/admin/comments/moderation`, {
        method: 'POST',
        headers: { Cookie: await 配信者のクッキー(env), Origin: サイト, 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      env,
      fetchImpl,
    )

  it('発言の削除は、botとしてその発言だけを消す', async () => {
    const { env } = await bot接続済みの環境()
    const { fetchImpl, 呼ばれた操作 } = 処分に応えるTwitch()

    const response = await 処分する(env, { action: 'delete', messageId: '荒らしの発言', userId: '11111' }, fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ action: 'delete' })
    expect(呼ばれた操作.map(({ method, url }) => [method, url.searchParams.get('moderator_id'), url.searchParams.get('message_id')])).toEqual([
      ['DELETE', botのID, '荒らしの発言'],
    ])
  })

  it('タイムアウトは、Workerが決めた長さでbotとして行い、その長さを返す', async () => {
    const { env } = await bot接続済みの環境()
    const { fetchImpl, 呼ばれた操作 } = 処分に応えるTwitch()

    const response = await 処分する(env, { action: 'timeout', messageId: '荒らしの発言', userId: '11111' }, fetchImpl)

    expect(await response.json()).toEqual({ action: 'timeout', durationSeconds: MANUAL_TIMEOUT_SECONDS })
    // Twitch はタイムアウトした人の発言をまとめて消すので、発言の削除は先に行わない
    expect(呼ばれた操作.map(({ method }) => method)).toEqual(['POST'])
    expect(呼ばれた操作[0]?.body).toMatchObject({ data: { user_id: '11111', duration: MANUAL_TIMEOUT_SECONDS } })
  })

  it('BANは、期限なしでbotとして行う', async () => {
    const { env } = await bot接続済みの環境()
    const { fetchImpl, 呼ばれた操作 } = 処分に応えるTwitch()

    const response = await 処分する(env, { action: 'ban', messageId: '荒らしの発言', userId: '11111' }, fetchImpl)

    expect(await response.json()).toEqual({ action: 'ban' })
    expect(呼ばれた操作[0]?.body).toMatchObject({ data: { user_id: '11111' } })
    expect((呼ばれた操作[0]?.body as { data: Record<string, unknown> }).data.duration).toBeUndefined()
  })

  it('知らない操作・項目の欠けた本文は400にする', async () => {
    const { env } = await bot接続済みの環境()

    for (const body of [{ action: 'kick', messageId: '発言', userId: '11111' }, { action: 'delete', userId: '11111' }, { action: 'ban', messageId: '発言' }]) {
      const response = await 処分する(env, body)
      expect(response.status).toBe(400)
    }
  })

  it('botを接続していなければ、理由を添えて断る', async () => {
    const { env } = 環境を作る()

    const response = await 処分する(env, { action: 'delete', messageId: '荒らしの発言', userId: '11111' })

    expect(response.status).toBe(401)
  })

  it('別のサイトから送られた処分は断る', async () => {
    const { env } = await bot接続済みの環境()

    const response = await 処分する(env, { action: 'ban', messageId: '荒らしの発言', userId: '11111' }, undefined, { Origin: 'https://evil.example.com' })

    expect(response.status).toBe(403)
  })
})

describe('POST /api/admin/comments/messages', () => {
  /** 配信者のトークンを保存した環境を作る。scopes を変えると、許可を取り直す前の状態を作れる */
  const 配信者がログイン済みの環境 = async (scopes: string[] = ['user:read:chat', 'user:write:chat']) => {
    const 作ったもの = 環境を作る()
    await saveToken(作ったもの.env.STORE, 'broadcaster', {
      accessToken: 'broadcaster-access-token',
      refreshToken: 'broadcaster-refresh-token',
      expiresAt: 現在時刻 + 60 * 60 * 1000,
      scopes,
      userId: 配信者のID,
      login: 'haishinsha',
    })
    return 作ったもの
  }

  /** チャットの送信に応える Twitch の代役。送られたリクエストを記録する */
  const 送信に応えるTwitch = () => {
    const 送ったもの: { authorization: string | null; body: unknown }[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      if (request.url === 'https://api.twitch.tv/helix/chat/messages' && request.method === 'POST') {
        送ったもの.push({ authorization: request.headers.get('Authorization'), body: await request.json() })
        return Response.json({ data: [{ message_id: '送った発言', is_sent: true }] })
      }
      throw new Error(`テストで想定していない通信です: ${request.method} ${request.url}`)
    }
    return { fetchImpl, 送ったもの }
  }

  const 送る = async (env: Env, body: unknown, fetchImpl?: typeof fetch, headers: Record<string, string> = {}) =>
    呼び出す(
      new Request(`${サイト}/api/admin/comments/messages`, {
        method: 'POST',
        headers: { Cookie: await 配信者のクッキー(env), Origin: サイト, 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      env,
      fetchImpl,
    )

  it('配信者のトークンで、配信者本人としてチャットへ送る', async () => {
    const { env } = await 配信者がログイン済みの環境()
    const { fetchImpl, 送ったもの } = 送信に応えるTwitch()

    const response = await 送る(env, { message: 'みなさん来てくれてありがとう' }, fetchImpl)

    expect(response.status).toBe(204)
    expect(送ったもの).toEqual([
      {
        authorization: 'Bearer broadcaster-access-token',
        body: { broadcaster_id: 配信者のID, sender_id: 配信者のID, message: 'みなさん来てくれてありがとう' },
      },
    ])
  })

  it('配信者がまだ user:write:chat を許可していなければ、botで送らずにログインし直すよう伝える', async () => {
    const { env } = await 配信者がログイン済みの環境(['user:read:chat'])

    const response = await 送る(env, { message: 'みなさん来てくれてありがとう' })

    expect(response.status).toBe(401)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('missing-scope')
    expect(body.error.message).toContain('ログインし直してください')
  })

  it('空の文言・500文字を超える文言は400にする', async () => {
    const { env } = await 配信者がログイン済みの環境()

    for (const message of ['', '   ', 'あ'.repeat(501)]) {
      const response = await 送る(env, { message })
      expect(response.status).toBe(400)
    }
  })

  it('別のサイトから送られたものは断る', async () => {
    const { env } = await 配信者がログイン済みの環境()

    const response = await 送る(env, { message: 'みなさん来てくれてありがとう' }, undefined, { Origin: 'https://evil.example.com' })

    expect(response.status).toBe(403)
  })
})

describe('POST /api/admin/comments/reads', () => {
  const 付け替える = async (env: Env, body: unknown, headers: Record<string, string> = {}) =>
    呼び出す(
      new Request(`${サイト}/api/admin/comments/reads`, {
        method: 'POST',
        headers: { Cookie: await 配信者のクッキー(env), Origin: サイト, 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      env,
    )

  /** 記録された既読の行をそのまま読む */
  const 既読の行 = (env: ReturnType<typeof 環境を作る>['env']) => env.DB.sqlite.prepare('SELECT message_id, read, marked_by FROM comment_reads').all()

  it('配信者が既読にした発言を記録し、開いている画面へ知らせる', async () => {
    const { env, 配送先 } = 環境を作る()

    const response = await 付け替える(env, { messageId: 'たなかさんの初見の挨拶', read: true })

    expect(response.status).toBe(204)
    expect(既読の行(env)).toEqual([{ message_id: 'たなかさんの初見の挨拶', read: 1, marked_by: 'manual' }])
    // 画面は届いた順に当てはめるので、付け替えるたびに別の通知として見分けられるIDを振る
    expect(配送先.押し出された1件).toEqual([
      { kind: 'read', id: expect.any(String), at: 現在時刻, messageId: 'たなかさんの初見の挨拶', read: true, by: 'manual' },
    ])
  })

  it('未読に戻したことも記録し、知らせる', async () => {
    const { env, 配送先 } = 環境を作る()
    await 付け替える(env, { messageId: 'すずきさんのBGMの質問', read: true })

    await 付け替える(env, { messageId: 'すずきさんのBGMの質問', read: false })

    expect(既読の行(env)).toEqual([{ message_id: 'すずきさんのBGMの質問', read: 0, marked_by: 'manual' }])
    expect(配送先.押し出された1件.map((item) => item.kind === 'read' && item.read)).toEqual([true, false])
    // 付け替えの通知は、1回ごとに違うIDを持つ（同じIDだと、画面が2回目を「当てはめ済み」として捨ててしまう）
    expect(new Set(配送先.押し出された1件.map((item) => item.id)).size).toBe(2)
  })

  it.each([
    ['発言のIDが無い', { read: true }],
    ['発言のIDが空', { messageId: '', read: true }],
    ['既読かどうかが真偽値でない', { messageId: 'たなかさんの初見の挨拶', read: 'はい' }],
  ])('%s本文は400で断り、記録も知らせもしない', async (_説明, body) => {
    const { env, 配送先 } = 環境を作る()

    const response = await 付け替える(env, body)

    expect(response.status).toBe(400)
    expect(既読の行(env)).toEqual([])
    expect(配送先.押し出された1件).toEqual([])
  })

  it('ログインしていなければ断る', async () => {
    const { env } = 環境を作る()

    const response = await 付け替える(env, { messageId: 'たなかさんの初見の挨拶', read: true }, { Cookie: '' })

    expect(response.status).toBe(401)
    expect(既読の行(env)).toEqual([])
  })

  it('画面へ知らせられなければ、成功として返さない（付け替えが画面に出ないことに気づけるようにする）', async () => {
    const { env } = 環境を作る()
    const 失敗する配送先 = createFakeCommentChannel({ 失敗する: true })

    const response = await 付け替える({ ...env, COMMENTS: 失敗する配送先.namespace }, { messageId: 'たなかさんの初見の挨拶', read: true })

    expect(response.ok).toBe(false)
    // 記録は先に済んでいる（画面はまだ未読のまま）。配信者が失敗を見てもう一度押せば揃う（次のテスト）
    expect(既読の行(env)).toEqual([{ message_id: 'たなかさんの初見の挨拶', read: 1, marked_by: 'manual' }])
  })

  it('知らせるのに失敗したあと、もう一度押せば記録と画面の状態が揃う', async () => {
    const { env, 配送先 } = 環境を作る()
    const 失敗する配送先 = createFakeCommentChannel({ 失敗する: true })
    await 付け替える({ ...env, COMMENTS: 失敗する配送先.namespace }, { messageId: 'たなかさんの初見の挨拶', read: true })

    // 画面は未読のままなので、配信者はもう一度「既読にする」を押す
    const response = await 付け替える(env, { messageId: 'たなかさんの初見の挨拶', read: true })

    expect(response.status).toBe(204)
    expect(既読の行(env)).toEqual([{ message_id: 'たなかさんの初見の挨拶', read: 1, marked_by: 'manual' }])
    expect(配送先.押し出された1件).toMatchObject([{ kind: 'read', messageId: 'たなかさんの初見の挨拶', read: true }])
  })
})

describe('/api/admin/comments/settings', () => {
  const 読む = async (env: Env) => 呼び出す(new Request(`${サイト}/api/admin/comments/settings`, { headers: { Cookie: await 配信者のクッキー(env) } }), env)

  const 保存する = async (env: Env, body: unknown) =>
    呼び出す(
      new Request(`${サイト}/api/admin/comments/settings`, {
        method: 'PUT',
        headers: { Cookie: await 配信者のクッキー(env), Origin: サイト, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
    )

  it('未保存なら、しばらく未読の発言を目立たせ、発話からの自動の既読はしない設定を返す', async () => {
    const { env } = 環境を作る()

    const response = await 読む(env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ highlightUnread: true, judgeWithJev: false })
  })

  it('保存した設定を返し、次に読んだときもその設定になる', async () => {
    const { env } = 環境を作る()

    const response = await 保存する(env, { highlightUnread: false, judgeWithJev: true })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ highlightUnread: false, judgeWithJev: true })
    expect(await (await 読む(env)).json()).toEqual({ highlightUnread: false, judgeWithJev: true })
  })

  it('形の違う設定は、問題点を添えて400で断る', async () => {
    const { env } = 環境を作る()

    const response = await 保存する(env, { highlightUnread: 'はい', judgeWithJev: false })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid-config' } })
  })
})
