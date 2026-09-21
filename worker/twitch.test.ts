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

describe('getAppAccessToken', () => {
  it('クライアントの資格情報でアプリアクセストークンを受け取る', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { access_token: 'test-app-token', expires_in: 5000000, token_type: 'bearer' })
    const accessToken = await クライアントを作る(fetchImpl).getAppAccessToken()

    expect(accessToken).toBe('test-app-token')
    const request = requests[0]!
    expect(request.url).toBe('https://id.twitch.tv/oauth2/token')
    expect(request.method).toBe('POST')
    const form = new URLSearchParams(await request.text())
    expect(form.get('grant_type')).toBe('client_credentials')
    expect(form.get('client_id')).toBe('test-client-id')
    expect(form.get('client_secret')).toBe('テスト用シークレット')
  })

  it('応答に access_token が無ければエラーになる', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { expires_in: 5000000 })
    await expect(クライアントを作る(fetchImpl).getAppAccessToken()).rejects.toBeInstanceOf(TwitchApiError)
  })
})

describe('createSubscription（Webhook宛て）', () => {
  it('コールバックのURLとシークレットを載せて購読を登録する', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(202, { data: [] })
    const subscription = {
      type: 'stream.online',
      version: '1',
      condition: { broadcaster_user_id: '12345' },
      transport: { method: 'webhook', callback: 'https://example.com/api/eventsub/webhook', secret: 'テスト用のWebhookシークレット' },
    } as const
    await クライアントを作る(fetchImpl).createSubscription('test-app-token', subscription)

    expect(await requests[0]!.json()).toEqual(subscription)
  })
})

describe('listSubscriptions', () => {
  it('ページをたどって、登録済みの購読をすべて返す', async () => {
    const requests: Request[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      requests.push(request)
      const 二ページ目 = new URL(request.url).searchParams.get('after') === '次のページ'
      return Response.json(
        二ページ目
          ? {
              data: [
                {
                  id: '購読2',
                  status: 'webhook_callback_verification_failed',
                  type: 'channel.raid',
                  version: '1',
                  condition: { to_broadcaster_user_id: '12345' },
                  transport: { method: 'webhook', callback: 'https://example.com/api/eventsub/webhook' },
                },
              ],
              pagination: {},
            }
          : {
              data: [{ id: '購読1', status: 'enabled', type: 'stream.online', version: '1', condition: { broadcaster_user_id: '12345' }, transport: { method: 'websocket', session_id: 'セッションID' } }],
              pagination: { cursor: '次のページ' },
            },
      )
    }
    const subscriptions = await クライアントを作る(fetchImpl).listSubscriptions('test-app-token')

    expect(subscriptions).toEqual([
      { id: '購読1', status: 'enabled', type: 'stream.online', version: '1', condition: { broadcaster_user_id: '12345' }, callback: null },
      {
        id: '購読2',
        status: 'webhook_callback_verification_failed',
        type: 'channel.raid',
        version: '1',
        condition: { to_broadcaster_user_id: '12345' },
        callback: 'https://example.com/api/eventsub/webhook',
      },
    ])
    expect(requests).toHaveLength(2)
    expect(requests[0]!.method).toBe('GET')
    expect(requests[0]!.headers.get('Authorization')).toBe('Bearer test-app-token')
    expect(requests[0]!.headers.get('Client-Id')).toBe('test-client-id')
  })

  it('応答が想定した形でなければエラーになる（黙って空の一覧にしない）', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { data: [{ id: '購読1' }] })
    await expect(クライアントを作る(fetchImpl).listSubscriptions('test-app-token')).rejects.toBeInstanceOf(TwitchApiError)
  })
})

describe('deleteSubscription', () => {
  it('購読をIDで削除する', async () => {
    const requests: Request[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push(new Request(input, init))
      return new Response(null, { status: 204 })
    }
    await クライアントを作る(fetchImpl).deleteSubscription('test-app-token', '購読1')

    const request = requests[0]!
    expect(request.method).toBe('DELETE')
    expect(new URL(request.url).searchParams.get('id')).toBe('購読1')
    expect(request.headers.get('Authorization')).toBe('Bearer test-app-token')
  })

  it('Twitchが失敗を返したら、状態コードを持つエラーになる', async () => {
    const { fetchImpl } = 応答を返すfetch(404, { error: 'Not Found', status: 404, message: 'subscription not found' })
    await expect(クライアントを作る(fetchImpl).deleteSubscription('test-app-token', '購読1')).rejects.toMatchObject({ status: 404 })
  })
})

describe('getChatBadges', () => {
  /** Twitchのバッジ応答1件分（グローバルの「配信者」バッジ） */
  const 配信者バッジ = {
    set_id: 'broadcaster',
    versions: [
      {
        id: '1',
        image_url_1x: 'https://static-cdn.jtvnw.net/badges/v1/broadcaster/1',
        image_url_2x: 'https://static-cdn.jtvnw.net/badges/v1/broadcaster/2',
        image_url_4x: 'https://static-cdn.jtvnw.net/badges/v1/broadcaster/3',
        title: 'Broadcaster',
      },
    ],
  }

  it('全体のバッジは broadcaster_id を付けずに取得する', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { data: [配信者バッジ] })
    const badges = await クライアントを作る(fetchImpl).getChatBadges('test-app-token', undefined)

    const url = new URL(requests[0]!.url)
    expect(url.origin + url.pathname).toBe('https://api.twitch.tv/helix/chat/badges/global')
    expect(url.searchParams.get('broadcaster_id')).toBeNull()
    expect(badges).toEqual([
      {
        setId: 'broadcaster',
        versions: [
          { id: '1', imageUrl: 'https://static-cdn.jtvnw.net/badges/v1/broadcaster/2', title: 'Broadcaster' },
        ],
      },
    ])
  })

  it('チャンネルのバッジは broadcaster_id を付けて取得する（サブスク階層など、そのチャンネル固有のバッジ）', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { data: [] })
    await クライアントを作る(fetchImpl).getChatBadges('test-app-token', '配信者ID-1')

    const url = new URL(requests[0]!.url)
    expect(url.origin + url.pathname).toBe('https://api.twitch.tv/helix/chat/badges')
    expect(url.searchParams.get('broadcaster_id')).toBe('配信者ID-1')
  })

  it('応答が想定した形でなければエラーになる（黙って空の一覧にしない）', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { data: [{ set_id: 'broadcaster' }] })
    await expect(クライアントを作る(fetchImpl).getChatBadges('test-app-token', undefined)).rejects.toBeInstanceOf(TwitchApiError)
  })
})

describe('getCheermotes', () => {
  /** Twitchの Cheermote 応答1件分（全体の「Cheer」。1ビッツ以上と100ビッツ以上の2段階） */
  const cheer = {
    prefix: 'Cheer',
    tiers: [
      {
        min_bits: 1,
        id: '1',
        color: '#979797',
        images: { dark: { animated: { '2': 'https://example.test/cheer/1/dark/animated/2.gif' } } },
      },
      {
        min_bits: 100,
        id: '100',
        color: '#9c3ee8',
        images: { dark: { animated: { '2': 'https://example.test/cheer/100/dark/animated/2.gif' } } },
      },
    ],
  }

  it('チャンネル固有のものも含めて取得し、段階ごとの最小ビッツ数・色・画像を取り出す', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { data: [cheer] })
    const cheermotes = await クライアントを作る(fetchImpl).getCheermotes('test-app-token', '配信者ID-1')

    const url = new URL(requests[0]!.url)
    expect(url.origin + url.pathname).toBe('https://api.twitch.tv/helix/bits/cheermotes')
    expect(url.searchParams.get('broadcaster_id')).toBe('配信者ID-1')
    expect(cheermotes).toEqual([
      {
        prefix: 'Cheer',
        tiers: [
          { minBits: 1, color: '#979797', imageUrl: 'https://example.test/cheer/1/dark/animated/2.gif' },
          { minBits: 100, color: '#9c3ee8', imageUrl: 'https://example.test/cheer/100/dark/animated/2.gif' },
        ],
      },
    ])
  })

  it('応答に画像のURLが無ければエラーになる（表示できないものを黙って混ぜない）', async () => {
    const { fetchImpl } = 応答を返すfetch(200, {
      data: [{ prefix: 'Cheer', tiers: [{ min_bits: 1, color: '#979797', images: {} }] }],
    })
    await expect(クライアントを作る(fetchImpl).getCheermotes('test-app-token', '配信者ID-1')).rejects.toBeInstanceOf(TwitchApiError)
  })
})

describe('getUserLogin', () => {
  it('ユーザーIDからログイン名を取得する', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { data: [{ id: '12345', login: 'tanenob', display_name: 'たねのぶ' }] })
    const login = await クライアントを作る(fetchImpl).getUserLogin('test-app-token', '12345')

    const url = new URL(requests[0]!.url)
    expect(url.origin + url.pathname).toBe('https://api.twitch.tv/helix/users')
    expect(url.searchParams.get('id')).toBe('12345')
    expect(login).toBe('tanenob')
  })

  it('そのIDのユーザーがいなければエラーになる', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { data: [] })
    await expect(クライアントを作る(fetchImpl).getUserLogin('test-app-token', '12345')).rejects.toBeInstanceOf(TwitchApiError)
  })
})

describe('sendChatMessage', () => {
  it('チャットへメッセージを送る', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { data: [{ message_id: 'abc', is_sent: true }] })

    await クライアントを作る(fetchImpl).sendChatMessage('bot-access-token', {
      broadcasterId: '12345',
      senderId: '67890',
      message: 'こんにちは、配信を見に来ました',
    })

    const request = requests[0]!
    expect(request.url).toBe('https://api.twitch.tv/helix/chat/messages')
    expect(request.method).toBe('POST')
    expect(request.headers.get('Authorization')).toBe('Bearer bot-access-token')
    expect(await request.json()).toEqual({ broadcaster_id: '12345', sender_id: '67890', message: 'こんにちは、配信を見に来ました' })
  })

  it('Twitchが失敗を返したら TwitchApiError になる', async () => {
    const { fetchImpl } = 応答を返すfetch(401, { status: 401, message: 'Missing scope: user:write:chat' })

    await expect(
      クライアントを作る(fetchImpl).sendChatMessage('bot-access-token-without-scope', { broadcasterId: '12345', senderId: '67890', message: 'テスト' }),
    ).rejects.toMatchObject({ name: 'TwitchApiError', status: 401 })
  })

  it('200で返ってきても is_sent が false なら、送信できなかったものとしてエラーにする', async () => {
    // TwitchはAutoModに止められた場合などに、200のまま is_sent: false と drop_reason を返す
    const { fetchImpl } = 応答を返すfetch(200, {
      data: [{ message_id: '', is_sent: false, drop_reason: { code: 'msg_rejected', message: 'メッセージがAutoModに保留されました' } }],
    })

    const error = await クライアントを作る(fetchImpl)
      .sendChatMessage('bot-access-token', { broadcasterId: '12345', senderId: '67890', message: 'あやしい文言' })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(TwitchApiError)
    // どうして送れなかったのかを管理画面で読めるよう、Twitchの理由をそのまま含める
    expect((error as TwitchApiError).message).toContain('メッセージがAutoModに保留されました')
  })
})
