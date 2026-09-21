/**
 * Twitch APIの呼び出し（twitch.ts）のテスト
 *
 * 実際のTwitchへは通信せず、fetch を差し替えて「どんなリクエストを送るか」と
 * 「失敗の応答をエラーとして扱うか」を確認する。
 */
import { describe, expect, it } from 'vitest'
import { TwitchApiError, createTwitchClient } from './twitch'

/** 送られたリクエストを記録し、決めた応答を返す fetch */
const 応答を返すfetch = (status: number, body: unknown) => {
  const requests: Request[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(input, init))
    return new Response(JSON.stringify(body), { status })
  }
  return { requests, fetchImpl }
}

const クライアントを作る = (fetchImpl: typeof fetch) =>
  createTwitchClient({ clientId: 'test-client-id', clientSecret: 'テスト用シークレット', fetch: fetchImpl })

describe('authorizeUrl', () => {
  it('Twitchの認可ページのURLに、クライアントID・戻り先・スコープ・stateを載せる', () => {
    const { fetchImpl } = 応答を返すfetch(200, {})
    const url = new URL(
      クライアントを作る(fetchImpl).authorizeUrl('https://example.com/api/auth/callback', 'ランダムなstate', [
        'channel:read:redemptions',
        'moderator:read:followers',
      ]),
    )
    expect(url.origin + url.pathname).toBe('https://id.twitch.tv/oauth2/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('test-client-id')
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/api/auth/callback')
    expect(url.searchParams.get('scope')).toBe('channel:read:redemptions moderator:read:followers')
    expect(url.searchParams.get('state')).toBe('ランダムなstate')
  })
})

describe('exchangeCode', () => {
  it('認可コードをトークンに交換する', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, {
      access_token: 'test-access-token',
      refresh_token: 'リフレッシュトークン',
      expires_in: 14400,
      scope: ['channel:read:redemptions'],
      token_type: 'bearer',
    })
    const grant = await クライアントを作る(fetchImpl).exchangeCode('認可コード', 'https://example.com/api/auth/callback')

    expect(grant).toEqual({ accessToken: 'test-access-token', refreshToken: 'リフレッシュトークン', expiresIn: 14400 })
    const request = requests[0]!
    expect(request.url).toBe('https://id.twitch.tv/oauth2/token')
    expect(request.method).toBe('POST')
    const form = new URLSearchParams(await request.text())
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('認可コード')
    expect(form.get('client_secret')).toBe('テスト用シークレット')
    expect(form.get('redirect_uri')).toBe('https://example.com/api/auth/callback')
  })

  it('Twitchが失敗を返したら TwitchApiError になる', async () => {
    const { fetchImpl } = 応答を返すfetch(400, { status: 400, message: 'Invalid authorization code' })
    await expect(クライアントを作る(fetchImpl).exchangeCode('使用済みのコード', 'https://example.com/cb')).rejects.toMatchObject({
      name: 'TwitchApiError',
      status: 400,
    })
  })

  it('応答に必要な項目が欠けていたらエラーになる', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { access_token: 'test-access-token' })
    await expect(クライアントを作る(fetchImpl).exchangeCode('認可コード', 'https://example.com/cb')).rejects.toBeInstanceOf(
      TwitchApiError,
    )
  })
})

describe('refresh', () => {
  it('リフレッシュトークンで新しいトークンを受け取る', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, {
      access_token: '新しいアクセストークン',
      refresh_token: '新しいリフレッシュトークン',
      expires_in: 14400,
    })
    const grant = await クライアントを作る(fetchImpl).refresh('古いリフレッシュトークン')

    expect(grant.accessToken).toBe('新しいアクセストークン')
    const form = new URLSearchParams(await requests[0]!.text())
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('古いリフレッシュトークン')
  })
})

describe('validate', () => {
  it('アクセストークンの持ち主とスコープを返す', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, {
      client_id: 'test-client-id',
      login: 'haishinsha',
      scopes: ['channel:read:redemptions'],
      user_id: '12345',
      expires_in: 14000,
    })
    const owner = await クライアントを作る(fetchImpl).validate('test-access-token')

    expect(owner).toEqual({ userId: '12345', login: 'haishinsha', scopes: ['channel:read:redemptions'] })
    expect(requests[0]!.url).toBe('https://id.twitch.tv/oauth2/validate')
    expect(requests[0]!.headers.get('Authorization')).toBe('OAuth test-access-token')
  })
})

describe('createSubscription', () => {
  it('HelixへEventSubの購読を登録する', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(202, { data: [] })
    const subscription = {
      type: 'channel.raid',
      version: '1',
      condition: { to_broadcaster_user_id: '12345' },
      transport: { method: 'websocket', session_id: 'セッションID' },
    } as const
    await クライアントを作る(fetchImpl).createSubscription('test-access-token', subscription)

    const request = requests[0]!
    expect(request.url).toBe('https://api.twitch.tv/helix/eventsub/subscriptions')
    expect(request.method).toBe('POST')
    expect(request.headers.get('Authorization')).toBe('Bearer test-access-token')
    expect(request.headers.get('Client-Id')).toBe('test-client-id')
    expect(await request.json()).toEqual(subscription)
  })

  it('Twitchが失敗を返したら、状態コードとメッセージを持つエラーになる', async () => {
    const { fetchImpl } = 応答を返すfetch(403, { error: 'Forbidden', status: 403, message: 'subscription missing proper authorization' })
    await expect(
      クライアントを作る(fetchImpl).createSubscription('test-access-token', {
        type: 'channel.follow',
        version: '2',
        condition: {},
        transport: { method: 'websocket', session_id: 'セッションID' },
      }),
    ).rejects.toMatchObject({ status: 403, message: expect.stringContaining('subscription missing proper authorization') })
  })
})

describe('listCustomRewards', () => {
  it('Helixから配信者のチャンネルポイント報酬を取得し、ID・名前・必要ポイントだけを返す', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, {
      data: [
        { id: '報酬ID-乾杯', title: '乾杯する', cost: 500, is_enabled: true, prompt: '' },
        { id: '報酬ID-おみくじ', title: 'おみくじを引く', cost: 100, is_enabled: false, prompt: '' },
      ],
    })

    const rewards = await クライアントを作る(fetchImpl).listCustomRewards('test-access-token', '12345')

    expect(rewards).toEqual([
      { id: '報酬ID-乾杯', title: '乾杯する', cost: 500 },
      { id: '報酬ID-おみくじ', title: 'おみくじを引く', cost: 100 },
    ])
    const request = requests[0]!
    expect(request.url).toBe('https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=12345')
    expect(request.headers.get('Authorization')).toBe('Bearer test-access-token')
    expect(request.headers.get('Client-Id')).toBe('test-client-id')
  })

  it('Twitchが失敗を返したら、状態コードを持つエラーになる（アフィリエイト未満のチャンネルなど）', async () => {
    const { fetchImpl } = 応答を返すfetch(403, { error: 'Forbidden', status: 403, message: 'channel points are not available for the broadcaster' })
    await expect(クライアントを作る(fetchImpl).listCustomRewards('test-access-token', '12345')).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('channel points are not available'),
    })
  })

  it('応答が想定した形でなければエラーになる（黙って空の一覧にしない）', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { data: [{ id: '報酬ID-乾杯' }] })
    await expect(クライアントを作る(fetchImpl).listCustomRewards('test-access-token', '12345')).rejects.toBeInstanceOf(TwitchApiError)
  })
})

describe('getLiveStream', () => {
  it('配信中なら、配信ID・開始日時・タイトル・カテゴリ・視聴者数を返す', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, {
      data: [
        {
          id: '40000000001',
          user_id: '12345',
          game_name: 'Just Chatting',
          type: 'live',
          title: '月曜の雑談配信',
          viewer_count: 42,
          started_at: '2026-09-21T12:00:00Z',
        },
      ],
    })

    const stream = await クライアントを作る(fetchImpl).getLiveStream('test-access-token', '12345')

    // 開始日時はミリ秒付きのISO 8601に揃える（データベースで文字列のまま比べるため）
    expect(stream).toEqual({
      id: '40000000001',
      startedAt: '2026-09-21T12:00:00.000Z',
      title: '月曜の雑談配信',
      categoryName: 'Just Chatting',
      viewerCount: 42,
    })
    const request = requests[0]!
    expect(request.url).toBe('https://api.twitch.tv/helix/streams?user_id=12345')
    expect(request.headers.get('Authorization')).toBe('Bearer test-access-token')
    expect(request.headers.get('Client-Id')).toBe('test-client-id')
  })

  it('配信していなければ null を返す', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { data: [] })
    expect(await クライアントを作る(fetchImpl).getLiveStream('test-access-token', '12345')).toBeNull()
  })

  it.each([
    ['必要な項目が欠けている', { data: [{ id: '40000000001', title: '月曜の雑談配信' }] }],
    [
      '開始日時が日時として読めない',
      { data: [{ id: '40000000001', game_name: '', title: '', viewer_count: 1, started_at: 'きのうの夜' }] },
    ],
    ['data が配列でない', { data: null }],
  ])('応答が想定した形でなければエラーになる（%s）', async (_説明, body) => {
    const { fetchImpl } = 応答を返すfetch(200, body)
    await expect(クライアントを作る(fetchImpl).getLiveStream('test-access-token', '12345')).rejects.toBeInstanceOf(TwitchApiError)
  })

  it('Twitchが失敗を返したら、状態コードを持つエラーになる', async () => {
    const { fetchImpl } = 応答を返すfetch(401, { error: 'Unauthorized', status: 401, message: 'Invalid OAuth token' })
    await expect(クライアントを作る(fetchImpl).getLiveStream('test-access-token', '12345')).rejects.toMatchObject({ status: 401 })
  })
})

describe('getFollowerTotal', () => {
  it('配信者のフォロワー数を返す', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { total: 1234, data: [], pagination: {} })

    expect(await クライアントを作る(fetchImpl).getFollowerTotal('test-access-token', '12345')).toBe(1234)
    const request = requests[0]!
    // 数だけが要るので、フォロワーの一覧は最小の1件にする
    expect(request.url).toBe('https://api.twitch.tv/helix/channels/followers?broadcaster_id=12345&first=1')
    expect(request.headers.get('Authorization')).toBe('Bearer test-access-token')
  })

  it('応答に total が無ければエラーになる（黙って0にしない）', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { data: [] })
    await expect(クライアントを作る(fetchImpl).getFollowerTotal('test-access-token', '12345')).rejects.toBeInstanceOf(TwitchApiError)
  })
})
