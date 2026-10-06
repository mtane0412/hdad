/**
 * Twitch APIの呼び出し（twitch.ts）のテスト
 *
 * 実際のTwitchへは通信せず、fetch を差し替えて「どんなリクエストを送るか」と
 * 「失敗の応答をエラーとして扱うか」を確認する。
 */
import { describe, expect, it } from 'vitest'
import { TimeoutError } from './timeout'
import { TwitchApiError, createTwitchClient } from './twitch'

/** 送られたリクエストを記録し、決めた応答を返す fetch */
const fetchReturning = (status: number, body: unknown) => {
  const requests: Request[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(input, init))
    return new Response(JSON.stringify(body), { status })
  }
  return { requests, fetchImpl }
}

/** 本文を返さない応答（204など）を返す fetch。モデレーション操作の成功はこの形で返る */
const fetchReturningNoBody = (status: number) => {
  const requests: Request[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(input, init))
    return new Response(null, { status })
  }
  return { requests, fetchImpl }
}

const createClient = (fetchImpl: typeof fetch) =>
  createTwitchClient({ clientId: 'test-client-id', clientSecret: 'テスト用シークレット', fetch: fetchImpl })

describe('authorizeUrl', () => {
  it('Twitchの認可ページのURLに、クライアントID・戻り先・スコープ・stateを載せる', () => {
    const { fetchImpl } = fetchReturning(200, {})
    const url = new URL(
      createClient(fetchImpl).authorizeUrl('https://example.com/api/auth/callback', 'ランダムなstate', [
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
    const { requests, fetchImpl } = fetchReturning(200, {
      access_token: 'test-access-token',
      refresh_token: 'リフレッシュトークン',
      expires_in: 14400,
      scope: ['channel:read:redemptions'],
      token_type: 'bearer',
    })
    const grant = await createClient(fetchImpl).exchangeCode('認可コード', 'https://example.com/api/auth/callback')

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
    const { fetchImpl } = fetchReturning(400, { status: 400, message: 'Invalid authorization code' })
    await expect(createClient(fetchImpl).exchangeCode('使用済みのコード', 'https://example.com/cb')).rejects.toMatchObject({
      name: 'TwitchApiError',
      status: 400,
    })
  })

  it('応答に必要な項目が欠けていたらエラーになる', async () => {
    const { fetchImpl } = fetchReturning(200, { access_token: 'test-access-token' })
    await expect(createClient(fetchImpl).exchangeCode('認可コード', 'https://example.com/cb')).rejects.toBeInstanceOf(
      TwitchApiError,
    )
  })
})

describe('refresh', () => {
  it('リフレッシュトークンで新しいトークンを受け取る', async () => {
    const { requests, fetchImpl } = fetchReturning(200, {
      access_token: '新しいアクセストークン',
      refresh_token: '新しいリフレッシュトークン',
      expires_in: 14400,
    })
    const grant = await createClient(fetchImpl).refresh('古いリフレッシュトークン')

    expect(grant.accessToken).toBe('新しいアクセストークン')
    const form = new URLSearchParams(await requests[0]!.text())
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('古いリフレッシュトークン')
  })
})

describe('validate', () => {
  it('アクセストークンの持ち主とスコープを返す', async () => {
    const { requests, fetchImpl } = fetchReturning(200, {
      client_id: 'test-client-id',
      login: 'haishinsha',
      scopes: ['channel:read:redemptions'],
      user_id: '12345',
      expires_in: 14000,
    })
    const owner = await createClient(fetchImpl).validate('test-access-token')

    expect(owner).toEqual({ userId: '12345', login: 'haishinsha', scopes: ['channel:read:redemptions'] })
    expect(requests[0]!.url).toBe('https://id.twitch.tv/oauth2/validate')
    expect(requests[0]!.headers.get('Authorization')).toBe('OAuth test-access-token')
  })
})

describe('revoke', () => {
  it('クライアントIDとアクセストークンを送り、Twitchでトークンを失効させる', async () => {
    const { requests, fetchImpl } = fetchReturningNoBody(200)

    await createClient(fetchImpl).revoke('外したbotのアクセストークン')

    expect(requests[0]!.url).toBe('https://id.twitch.tv/oauth2/revoke')
    expect(requests[0]!.method).toBe('POST')
    const form = new URLSearchParams(await requests[0]!.text())
    expect(form.get('client_id')).toBe('test-client-id')
    expect(form.get('token')).toBe('外したbotのアクセストークン')
    // 失効にはクライアントシークレットが要らない。要らない秘密は送らない
    expect(form.has('client_secret')).toBe(false)
  })

  it('トークンがすでに無効（400 Invalid token）なら、失効済みとして成功にする', async () => {
    const { fetchImpl } = fetchReturning(400, { status: 400, message: 'Invalid token' })

    await expect(createClient(fetchImpl).revoke('期限切れのアクセストークン')).resolves.toBeUndefined()
  })

  it('トークン以外の理由の400（クライアントIDの誤りなど）は、失効できていないのでエラーにする', async () => {
    const { fetchImpl } = fetchReturning(400, { status: 400, message: 'invalid client' })

    await expect(createClient(fetchImpl).revoke('外したbotのアクセストークン')).rejects.toMatchObject({ name: 'TwitchApiError', status: 400 })
  })

  it('Twitch側の障害（5xx）は、状態コードを残したエラーにする', async () => {
    const { fetchImpl } = fetchReturning(503, { status: 503, message: 'Service Unavailable' })

    await expect(createClient(fetchImpl).revoke('外したbotのアクセストークン')).rejects.toMatchObject({ name: 'TwitchApiError', status: 503 })
  })
})

describe('createSubscription', () => {
  it('HelixへEventSubの購読を登録する', async () => {
    const { requests, fetchImpl } = fetchReturning(202, { data: [] })
    const subscription = {
      type: 'channel.raid',
      version: '1',
      condition: { to_broadcaster_user_id: '12345' },
      transport: { method: 'webhook', callback: 'https://hdad.example.com/api/eventsub/webhook', secret: 'テスト用のWebhookシークレット' },
    } as const
    await createClient(fetchImpl).createSubscription('test-access-token', subscription)

    const request = requests[0]!
    expect(request.url).toBe('https://api.twitch.tv/helix/eventsub/subscriptions')
    expect(request.method).toBe('POST')
    expect(request.headers.get('Authorization')).toBe('Bearer test-access-token')
    expect(request.headers.get('Client-Id')).toBe('test-client-id')
    expect(await request.json()).toEqual(subscription)
  })

  it('Twitchが失敗を返したら、状態コードとメッセージを持つエラーになる', async () => {
    const { fetchImpl } = fetchReturning(403, { error: 'Forbidden', status: 403, message: 'subscription missing proper authorization' })
    await expect(
      createClient(fetchImpl).createSubscription('test-access-token', {
        type: 'channel.follow',
        version: '2',
        condition: {},
        transport: { method: 'webhook', callback: 'https://hdad.example.com/api/eventsub/webhook', secret: 'テスト用のWebhookシークレット' },
      }),
    ).rejects.toMatchObject({ status: 403, message: expect.stringContaining('subscription missing proper authorization') })
  })
})

/** Twitchが用意している既定の報酬画像（2倍の大きさ） */
const defaultImage = { url_1x: 'https://static-cdn.jtvnw.net/custom-reward-images/default-1.png', url_2x: 'https://static-cdn.jtvnw.net/custom-reward-images/default-2.png', url_4x: 'https://static-cdn.jtvnw.net/custom-reward-images/default-4.png' }
/** 配信者がアップロードした報酬画像 */
const uploadedImage = { url_1x: 'https://static-cdn.jtvnw.net/custom-reward-images/12345/kanpai-1.png', url_2x: 'https://static-cdn.jtvnw.net/custom-reward-images/12345/kanpai-2.png', url_4x: 'https://static-cdn.jtvnw.net/custom-reward-images/12345/kanpai-4.png' }

describe('listCustomRewards', () => {
  it('Helixから配信者のチャンネルポイント報酬を取得し、管理画面で扱う項目だけを返す', async () => {
    const { requests, fetchImpl } = fetchReturning(200, {
      data: [
        { id: '報酬ID-乾杯', title: '乾杯する', cost: 500, is_enabled: true, prompt: '', is_user_input_required: false, is_paused: false, image: uploadedImage, default_image: defaultImage },
        { id: '報酬ID-おみくじ', title: 'おみくじを引く', cost: 100, is_enabled: false, prompt: '一言どうぞ', is_user_input_required: true, image: null, default_image: defaultImage },
      ],
    })

    const rewards = await createClient(fetchImpl).listCustomRewards('test-access-token', '12345')

    expect(rewards).toEqual([
      // 画像は、配信者がアップロードしたものがあればそれを、なければTwitchの既定の画像を使う（2倍の大きさ）
      { id: '報酬ID-乾杯', title: '乾杯する', cost: 500, prompt: '', isEnabled: true, isUserInputRequired: false, imageUrl: 'https://static-cdn.jtvnw.net/custom-reward-images/12345/kanpai-2.png' },
      { id: '報酬ID-おみくじ', title: 'おみくじを引く', cost: 100, prompt: '一言どうぞ', isEnabled: false, isUserInputRequired: true, imageUrl: 'https://static-cdn.jtvnw.net/custom-reward-images/default-2.png' },
    ])
    const request = requests[0]!
    expect(request.url).toBe('https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=12345')
    expect(request.headers.get('Authorization')).toBe('Bearer test-access-token')
    expect(request.headers.get('Client-Id')).toBe('test-client-id')
  })

  it('onlyManageable を指定すると、このアプリが作った報酬だけを求める', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { data: [] })

    await createClient(fetchImpl).listCustomRewards('test-access-token', '12345', { onlyManageable: true })

    expect(requests[0]!.url).toBe('https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=12345&only_manageable_rewards=true')
  })

  it('Twitchが失敗を返したら、状態コードを持つエラーになる（アフィリエイト未満のチャンネルなど）', async () => {
    const { fetchImpl } = fetchReturning(403, { error: 'Forbidden', status: 403, message: 'channel points are not available for the broadcaster' })
    await expect(createClient(fetchImpl).listCustomRewards('test-access-token', '12345')).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('channel points are not available'),
    })
  })

  it('既定の画像も無い報酬が届いたらエラーになる（画像の無い報酬として黙って扱わない）', async () => {
    const { fetchImpl } = fetchReturning(200, {
      data: [{ id: '報酬ID-乾杯', title: '乾杯する', cost: 500, is_enabled: true, prompt: '', is_user_input_required: false, image: null, default_image: null }],
    })
    await expect(createClient(fetchImpl).listCustomRewards('test-access-token', '12345')).rejects.toBeInstanceOf(TwitchApiError)
  })

  it('応答が想定した形でなければエラーになる（黙って空の一覧にしない）', async () => {
    const { fetchImpl } = fetchReturning(200, { data: [{ id: '報酬ID-乾杯' }] })
    await expect(createClient(fetchImpl).listCustomRewards('test-access-token', '12345')).rejects.toBeInstanceOf(TwitchApiError)
  })
})

/** 報酬の作成・更新で送る内容の例 */
const rewardInput = { title: '乾杯する', cost: 500, prompt: 'おつまみも添えて', isEnabled: true, isUserInputRequired: false }

/** Twitchが作成・更新の応答として返す報酬の例 */
const twitchReward = {
  id: '報酬ID-乾杯',
  title: '乾杯する',
  cost: 500,
  prompt: 'おつまみも添えて',
  is_enabled: true,
  is_user_input_required: false,
  is_paused: false,
  image: null,
  default_image: defaultImage,
}

describe('createCustomReward', () => {
  it('Helixへ報酬の内容をTwitchの項目名で送り、作られた報酬を返す', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { data: [twitchReward] })

    const reward = await createClient(fetchImpl).createCustomReward('test-access-token', '12345', rewardInput)

    expect(reward).toEqual({ id: '報酬ID-乾杯', ...rewardInput, imageUrl: 'https://static-cdn.jtvnw.net/custom-reward-images/default-2.png' })
    const request = requests[0]!
    expect(request.method).toBe('POST')
    expect(request.url).toBe('https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=12345')
    expect(request.headers.get('Authorization')).toBe('Bearer test-access-token')
    expect(request.headers.get('Client-Id')).toBe('test-client-id')
    expect(request.headers.get('Content-Type')).toBe('application/json')
    expect(await request.json()).toEqual({
      title: '乾杯する',
      cost: 500,
      prompt: 'おつまみも添えて',
      is_enabled: true,
      is_user_input_required: false,
    })
  })

  it('Twitchが失敗を返したら、状態コードとメッセージを持つエラーになる（同じ名前の報酬があるなど）', async () => {
    const { fetchImpl } = fetchReturning(400, { error: 'Bad Request', status: 400, message: 'CREATE_CUSTOM_REWARD_DUPLICATE_REWARD' })
    await expect(createClient(fetchImpl).createCustomReward('test-access-token', '12345', rewardInput)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('DUPLICATE_REWARD'),
    })
  })

  it('応答に作られた報酬が無ければエラーになる', async () => {
    const { fetchImpl } = fetchReturning(200, { data: [] })
    await expect(createClient(fetchImpl).createCustomReward('test-access-token', '12345', rewardInput)).rejects.toBeInstanceOf(TwitchApiError)
  })
})

describe('updateCustomReward', () => {
  it('報酬のIDを指定してHelixへ新しい内容を送り、更新後の報酬を返す', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { data: [{ ...twitchReward, cost: 800 }] })

    const reward = await createClient(fetchImpl).updateCustomReward('test-access-token', '12345', '報酬ID-乾杯', { ...rewardInput, cost: 800 })

    expect(reward).toEqual({ id: '報酬ID-乾杯', ...rewardInput, cost: 800, imageUrl: 'https://static-cdn.jtvnw.net/custom-reward-images/default-2.png' })
    const request = requests[0]!
    expect(request.method).toBe('PATCH')
    const url = new URL(request.url)
    expect(url.searchParams.get('broadcaster_id')).toBe('12345')
    expect(url.searchParams.get('id')).toBe('報酬ID-乾杯')
    expect(await request.json()).toEqual({
      title: '乾杯する',
      cost: 800,
      prompt: 'おつまみも添えて',
      is_enabled: true,
      is_user_input_required: false,
    })
  })

  it('このアプリが作っていない報酬ではTwitchが403を返し、エラーになる', async () => {
    const { fetchImpl } = fetchReturning(403, { error: 'Forbidden', status: 403, message: 'The client-id does not match' })
    await expect(
      createClient(fetchImpl).updateCustomReward('test-access-token', '12345', '報酬ID-よそ', rewardInput),
    ).rejects.toMatchObject({ status: 403 })
  })
})

describe('deleteCustomReward', () => {
  it('報酬のIDを指定してHelixへ削除を送る（成功の応答は本文のない204）', async () => {
    const { requests, fetchImpl } = fetchReturningNoBody(204)

    await createClient(fetchImpl).deleteCustomReward('test-access-token', '12345', '報酬ID-乾杯')

    const request = requests[0]!
    expect(request.method).toBe('DELETE')
    const url = new URL(request.url)
    expect(url.searchParams.get('broadcaster_id')).toBe('12345')
    expect(url.searchParams.get('id')).toBe('報酬ID-乾杯')
    expect(request.headers.get('Authorization')).toBe('Bearer test-access-token')
  })

  it('Twitchが失敗を返したら、状態コードを持つエラーになる', async () => {
    const { fetchImpl } = fetchReturning(404, { error: 'Not Found', status: 404, message: 'reward not found' })
    await expect(createClient(fetchImpl).deleteCustomReward('test-access-token', '12345', '報酬ID-乾杯')).rejects.toMatchObject({ status: 404 })
  })
})

describe('getLiveStream', () => {
  it('配信中なら、配信ID・開始日時・タイトル・カテゴリ・視聴者数を返す', async () => {
    const { requests, fetchImpl } = fetchReturning(200, {
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

    const stream = await createClient(fetchImpl).getLiveStream('test-access-token', '12345')

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
    const { fetchImpl } = fetchReturning(200, { data: [] })
    expect(await createClient(fetchImpl).getLiveStream('test-access-token', '12345')).toBeNull()
  })

  it.each([
    ['必要な項目が欠けている', { data: [{ id: '40000000001', title: '月曜の雑談配信' }] }],
    [
      '開始日時が日時として読めない',
      { data: [{ id: '40000000001', game_name: '', title: '', viewer_count: 1, started_at: 'きのうの夜' }] },
    ],
    ['data が配列でない', { data: null }],
  ])('応答が想定した形でなければエラーになる（%s）', async (_description, body) => {
    const { fetchImpl } = fetchReturning(200, body)
    await expect(createClient(fetchImpl).getLiveStream('test-access-token', '12345')).rejects.toBeInstanceOf(TwitchApiError)
  })

  it('Twitchが失敗を返したら、状態コードを持つエラーになる', async () => {
    const { fetchImpl } = fetchReturning(401, { error: 'Unauthorized', status: 401, message: 'Invalid OAuth token' })
    await expect(createClient(fetchImpl).getLiveStream('test-access-token', '12345')).rejects.toMatchObject({ status: 401 })
  })
})

describe('getChannel', () => {
  it('その人のチャンネルの、最後に配信したカテゴリとタイトルを返す', async () => {
    const { requests, fetchImpl } = fetchReturning(200, {
      data: [
        {
          broadcaster_id: '100',
          broadcaster_login: 'hanako',
          broadcaster_name: '花子',
          game_name: 'Cuphead',
          title: '初見でボスラッシュ',
        },
      ],
    })

    const channel = await createClient(fetchImpl).getChannel('test-access-token', '100')

    expect(channel).toEqual({ categoryName: 'Cuphead', title: '初見でボスラッシュ' })
    const request = requests[0]!
    expect(request.url).toBe('https://api.twitch.tv/helix/channels?broadcaster_id=100')
    expect(request.headers.get('Authorization')).toBe('Bearer test-access-token')
    expect(request.headers.get('Client-Id')).toBe('test-client-id')
  })

  it('一度も配信していない人では、カテゴリとタイトルが空文字で返る（Twitchが空文字を返すため）', async () => {
    const { fetchImpl } = fetchReturning(200, { data: [{ broadcaster_id: '100', game_name: '', title: '' }] })

    expect(await createClient(fetchImpl).getChannel('test-access-token', '100')).toEqual({ categoryName: '', title: '' })
  })

  it.each([
    ['チャンネルが1件も返らない（消えたアカウント）', { data: [] }],
    ['必要な項目が欠けている', { data: [{ broadcaster_id: '100', game_name: 'Cuphead' }] }],
    ['data が配列でない', { data: null }],
  ])('応答が想定した形でなければエラーになる（%s）', async (_description, body) => {
    const { fetchImpl } = fetchReturning(200, body)
    await expect(createClient(fetchImpl).getChannel('test-access-token', '100')).rejects.toBeInstanceOf(TwitchApiError)
  })
})

describe('getChannelDetail', () => {
  it('チャンネルの、最後に配信したカテゴリとタイトルに加えて、タグを返す', async () => {
    const { requests, fetchImpl } = fetchReturning(200, {
      data: [{ broadcaster_id: '100', game_name: 'ELDEN RING', title: '初見DLC', tags: ['日本語', '初見'] }],
    })

    expect(await createClient(fetchImpl).getChannelDetail('test-access-token', '100')).toEqual({
      categoryName: 'ELDEN RING',
      title: '初見DLC',
      tags: ['日本語', '初見'],
    })
    expect(requests[0]!.url).toBe('https://api.twitch.tv/helix/channels?broadcaster_id=100')
  })

  it('タグを付けていないチャンネルでは、空の並びを返す（Twitch が空の配列を返すため）', async () => {
    const { fetchImpl } = fetchReturning(200, { data: [{ broadcaster_id: '100', game_name: '', title: '', tags: [] }] })

    expect(await createClient(fetchImpl).getChannelDetail('test-access-token', '100')).toEqual({ categoryName: '', title: '', tags: [] })
  })

  it('タグが文字列の並びでなければエラーになる', async () => {
    const { fetchImpl } = fetchReturning(200, { data: [{ broadcaster_id: '100', game_name: '', title: '', tags: null }] })

    await expect(createClient(fetchImpl).getChannelDetail('test-access-token', '100')).rejects.toBeInstanceOf(TwitchApiError)
  })
})

describe('getUserByLogin', () => {
  it('ログイン名から、ユーザーID・表示名・自己紹介・アイコンを返す', async () => {
    const { requests, fetchImpl } = fetchReturning(200, {
      data: [
        {
          id: '200',
          login: 'hoshino_yu',
          display_name: '星野ゆう',
          description: '週末に歌枠をしています',
          profile_image_url: 'https://static-cdn.jtvnw.net/hoshino.png',
        },
      ],
    })

    expect(await createClient(fetchImpl).getUserByLogin('test-access-token', 'hoshino_yu')).toEqual({
      id: '200',
      login: 'hoshino_yu',
      displayName: '星野ゆう',
      description: '週末に歌枠をしています',
      profileImageUrl: 'https://static-cdn.jtvnw.net/hoshino.png',
    })
    expect(requests[0]!.url).toBe('https://api.twitch.tv/helix/users?login=hoshino_yu')
  })

  it('そのログイン名のユーザーがいなければ null を返す（打ち間違いを、Twitch の失敗と分けて伝えるため）', async () => {
    const { fetchImpl } = fetchReturning(200, { data: [] })

    expect(await createClient(fetchImpl).getUserByLogin('test-access-token', 'no_such_user')).toBeNull()
  })

  it('必要な項目が欠けていればエラーになる', async () => {
    const { fetchImpl } = fetchReturning(200, { data: [{ id: '200', login: 'hoshino_yu' }] })

    await expect(createClient(fetchImpl).getUserByLogin('test-access-token', 'hoshino_yu')).rejects.toBeInstanceOf(TwitchApiError)
  })
})

describe('getFollowerTotal', () => {
  it('配信者のフォロワー数を返す', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { total: 1234, data: [], pagination: {} })

    expect(await createClient(fetchImpl).getFollowerTotal('test-access-token', '12345')).toBe(1234)
    const request = requests[0]!
    // 数だけが要るので、フォロワーの一覧は最小の1件にする
    expect(request.url).toBe('https://api.twitch.tv/helix/channels/followers?broadcaster_id=12345&first=1')
    expect(request.headers.get('Authorization')).toBe('Bearer test-access-token')
  })

  it('応答に total が無ければエラーになる（黙って0にしない）', async () => {
    const { fetchImpl } = fetchReturning(200, { data: [] })
    await expect(createClient(fetchImpl).getFollowerTotal('test-access-token', '12345')).rejects.toBeInstanceOf(TwitchApiError)
  })
})

describe('getAppAccessToken', () => {
  it('クライアントの資格情報でアプリアクセストークンを受け取る', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { access_token: 'test-app-token', expires_in: 5000000, token_type: 'bearer' })
    const accessToken = await createClient(fetchImpl).getAppAccessToken()

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
    const { fetchImpl } = fetchReturning(200, { expires_in: 5000000 })
    await expect(createClient(fetchImpl).getAppAccessToken()).rejects.toBeInstanceOf(TwitchApiError)
  })
})

describe('createSubscription（Webhook宛て）', () => {
  it('コールバックのURLとシークレットを載せて購読を登録する', async () => {
    const { requests, fetchImpl } = fetchReturning(202, { data: [] })
    const subscription = {
      type: 'stream.online',
      version: '1',
      condition: { broadcaster_user_id: '12345' },
      transport: { method: 'webhook', callback: 'https://example.com/api/eventsub/webhook', secret: 'テスト用のWebhookシークレット' },
    } as const
    await createClient(fetchImpl).createSubscription('test-app-token', subscription)

    expect(await requests[0]!.json()).toEqual(subscription)
  })
})

describe('listSubscriptions', () => {
  it('ページをたどって、登録済みの購読をすべて返す', async () => {
    const requests: Request[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      requests.push(request)
      const secondPage = new URL(request.url).searchParams.get('after') === '次のページ'
      return Response.json(
        secondPage
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
    const subscriptions = await createClient(fetchImpl).listSubscriptions('test-app-token')

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
    const { fetchImpl } = fetchReturning(200, { data: [{ id: '購読1' }] })
    await expect(createClient(fetchImpl).listSubscriptions('test-app-token')).rejects.toBeInstanceOf(TwitchApiError)
  })
})

describe('deleteSubscription', () => {
  it('購読をIDで削除する', async () => {
    const requests: Request[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push(new Request(input, init))
      return new Response(null, { status: 204 })
    }
    await createClient(fetchImpl).deleteSubscription('test-app-token', '購読1')

    const request = requests[0]!
    expect(request.method).toBe('DELETE')
    expect(new URL(request.url).searchParams.get('id')).toBe('購読1')
    expect(request.headers.get('Authorization')).toBe('Bearer test-app-token')
  })

  it('Twitchが失敗を返したら、状態コードを持つエラーになる', async () => {
    const { fetchImpl } = fetchReturning(404, { error: 'Not Found', status: 404, message: 'subscription not found' })
    await expect(createClient(fetchImpl).deleteSubscription('test-app-token', '購読1')).rejects.toMatchObject({ status: 404 })
  })
})

describe('getChatBadges', () => {
  /** Twitchのバッジ応答1件分（グローバルの「配信者」バッジ） */
  const broadcasterBadge = {
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
    const { requests, fetchImpl } = fetchReturning(200, { data: [broadcasterBadge] })
    const badges = await createClient(fetchImpl).getChatBadges('test-app-token', undefined)

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
    const { requests, fetchImpl } = fetchReturning(200, { data: [] })
    await createClient(fetchImpl).getChatBadges('test-app-token', '配信者ID-1')

    const url = new URL(requests[0]!.url)
    expect(url.origin + url.pathname).toBe('https://api.twitch.tv/helix/chat/badges')
    expect(url.searchParams.get('broadcaster_id')).toBe('配信者ID-1')
  })

  it('応答が想定した形でなければエラーになる（黙って空の一覧にしない）', async () => {
    const { fetchImpl } = fetchReturning(200, { data: [{ set_id: 'broadcaster' }] })
    await expect(createClient(fetchImpl).getChatBadges('test-app-token', undefined)).rejects.toBeInstanceOf(TwitchApiError)
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
    const { requests, fetchImpl } = fetchReturning(200, { data: [cheer] })
    const cheermotes = await createClient(fetchImpl).getCheermotes('test-app-token', '配信者ID-1')

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
    const { fetchImpl } = fetchReturning(200, {
      data: [{ prefix: 'Cheer', tiers: [{ min_bits: 1, color: '#979797', images: {} }] }],
    })
    await expect(createClient(fetchImpl).getCheermotes('test-app-token', '配信者ID-1')).rejects.toBeInstanceOf(TwitchApiError)
  })
})

describe('getUserLogin', () => {
  it('ユーザーIDからログイン名を取得する', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { data: [{ id: '12345', login: 'tanenob', display_name: 'たねのぶ' }] })
    const login = await createClient(fetchImpl).getUserLogin('test-app-token', '12345')

    const url = new URL(requests[0]!.url)
    expect(url.origin + url.pathname).toBe('https://api.twitch.tv/helix/users')
    expect(url.searchParams.get('id')).toBe('12345')
    expect(login).toBe('tanenob')
  })

  it('そのIDのユーザーがいなければエラーになる', async () => {
    const { fetchImpl } = fetchReturning(200, { data: [] })
    await expect(createClient(fetchImpl).getUserLogin('test-app-token', '12345')).rejects.toBeInstanceOf(TwitchApiError)
  })
})

describe('getProfileImageUrl', () => {
  it('ログイン名からアイコン画像のURLを取得する', async () => {
    const { requests, fetchImpl } = fetchReturning(200, {
      data: [{ id: '100', login: 'kowai_hanashi', profile_image_url: 'https://static-cdn.jtvnw.net/jtv_user_pictures/kowai.png' }],
    })
    const url = await createClient(fetchImpl).getProfileImageUrl('test-app-token', 'kowai_hanashi')

    const requested = new URL(requests[0]!.url)
    expect(requested.origin + requested.pathname).toBe('https://api.twitch.tv/helix/users')
    expect(requested.searchParams.get('login')).toBe('kowai_hanashi')
    expect(url).toBe('https://static-cdn.jtvnw.net/jtv_user_pictures/kowai.png')
  })

  it('そのログイン名のユーザーがいなければエラーになる（名前を変えた・消えた人）', async () => {
    const { fetchImpl } = fetchReturning(200, { data: [] })
    await expect(createClient(fetchImpl).getProfileImageUrl('test-app-token', 'kieta_hito')).rejects.toBeInstanceOf(TwitchApiError)
  })

  it('アイコンのURLが空・https で始まらないものならエラーになる（映せないURLを保存しないため）', async () => {
    for (const brokenUrl of ['', 'http://static-cdn.jtvnw.net/kowai.png', 'javascript:alert(1)']) {
      const { fetchImpl } = fetchReturning(200, { data: [{ id: '100', login: 'kowai_hanashi', profile_image_url: brokenUrl }] })
      await expect(createClient(fetchImpl).getProfileImageUrl('test-app-token', 'kowai_hanashi')).rejects.toBeInstanceOf(TwitchApiError)
    }
  })
})

describe('getProfileImageUrls', () => {
  it('ユーザーIDをまとめて渡し、IDごとのアイコン画像のURLを受け取る', async () => {
    const { requests, fetchImpl } = fetchReturning(200, {
      data: [
        { id: '100', login: 'jouren_san', profile_image_url: 'https://static-cdn.jtvnw.net/jtv_user_pictures/jouren.png' },
        { id: '200', login: 'shoken_san', profile_image_url: 'https://static-cdn.jtvnw.net/jtv_user_pictures/shoken.png' },
      ],
    })
    const icons = await createClient(fetchImpl).getProfileImageUrls('test-app-token', ['100', '200'])

    const requested = new URL(requests[0]!.url)
    expect(requested.origin + requested.pathname).toBe('https://api.twitch.tv/helix/users')
    expect(requested.searchParams.getAll('id')).toEqual(['100', '200'])
    expect(icons).toEqual({
      '100': 'https://static-cdn.jtvnw.net/jtv_user_pictures/jouren.png',
      '200': 'https://static-cdn.jtvnw.net/jtv_user_pictures/shoken.png',
    })
  })

  it('Twitchが返さなかった人（消えたアカウント）は、結果に含めない', async () => {
    const { fetchImpl } = fetchReturning(200, {
      data: [{ id: '100', login: 'jouren_san', profile_image_url: 'https://static-cdn.jtvnw.net/jtv_user_pictures/jouren.png' }],
    })
    expect(await createClient(fetchImpl).getProfileImageUrls('test-app-token', ['100', '消えた人のID'])).toEqual({
      '100': 'https://static-cdn.jtvnw.net/jtv_user_pictures/jouren.png',
    })
  })

  it('アイコンのURLが https で始まらない人がいればエラーになる（画面の img に入れられないため）', async () => {
    const { fetchImpl } = fetchReturning(200, { data: [{ id: '100', login: 'jouren_san', profile_image_url: 'javascript:alert(1)' }] })
    await expect(createClient(fetchImpl).getProfileImageUrls('test-app-token', ['100'])).rejects.toBeInstanceOf(TwitchApiError)
  })
})

describe('sendChatMessage', () => {
  it('チャットへメッセージを送る', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { data: [{ message_id: 'abc', is_sent: true }] })

    await createClient(fetchImpl).sendChatMessage('bot-access-token', {
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
    const { fetchImpl } = fetchReturning(401, { status: 401, message: 'Missing scope: user:write:chat' })

    await expect(
      createClient(fetchImpl).sendChatMessage('bot-access-token-without-scope', { broadcasterId: '12345', senderId: '67890', message: 'テスト' }),
    ).rejects.toMatchObject({ name: 'TwitchApiError', status: 401 })
  })

  it('200で返ってきても is_sent が false なら、送信できなかったものとしてエラーにする', async () => {
    // TwitchはAutoModに止められた場合などに、200のまま is_sent: false と drop_reason を返す
    const { fetchImpl } = fetchReturning(200, {
      data: [{ message_id: '', is_sent: false, drop_reason: { code: 'msg_rejected', message: 'メッセージがAutoModに保留されました' } }],
    })

    const error = await createClient(fetchImpl)
      .sendChatMessage('bot-access-token', { broadcasterId: '12345', senderId: '67890', message: 'あやしい文言' })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(TwitchApiError)
    // どうして送れなかったのかを管理画面で読めるよう、Twitchの理由をそのまま含める
    expect((error as TwitchApiError).message).toContain('メッセージがAutoModに保留されました')
  })
})

describe('banUser', () => {
  it('期間を指定するとタイムアウトになる（duration に秒数を載せる）', async () => {
    const { requests, fetchImpl } = fetchReturning(200, {
      data: [{ broadcaster_id: '12345', moderator_id: 'botのユーザーID', user_id: '荒らしのユーザーID', end_time: '2026-09-21T12:10:00Z' }],
    })

    await createClient(fetchImpl).banUser('bot-access-token', {
      broadcasterId: '12345',
      moderatorId: 'botのユーザーID',
      userId: '荒らしのユーザーID',
      durationSeconds: 600,
      reason: '宣伝のURLを繰り返し貼ったため',
    })

    const request = requests[0]!
    const url = new URL(request.url)
    expect(url.origin + url.pathname).toBe('https://api.twitch.tv/helix/moderation/bans')
    expect(url.searchParams.get('broadcaster_id')).toBe('12345')
    // moderator_id はアクセストークンの持ち主（bot）と一致している必要がある
    expect(url.searchParams.get('moderator_id')).toBe('botのユーザーID')
    expect(request.method).toBe('POST')
    expect(await request.json()).toEqual({ data: { user_id: '荒らしのユーザーID', duration: 600, reason: '宣伝のURLを繰り返し貼ったため' } })
  })

  it('期間を省略すると永久BANになる（duration を載せない）', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { data: [{ user_id: '荒らしのユーザーID' }] })

    await createClient(fetchImpl).banUser('bot-access-token', {
      broadcasterId: '12345',
      moderatorId: 'botのユーザーID',
      userId: '荒らしのユーザーID',
    })

    expect(await requests[0]!.json()).toEqual({ data: { user_id: '荒らしのユーザーID' } })
  })

  it('すでにBAN済み・タイムアウト中なら 409 の TwitchApiError になる', async () => {
    // 呼び出し側が「処分済み」として扱えるよう、状態コードをそのまま残す
    const { fetchImpl } = fetchReturning(409, { error: 'Conflict', status: 409, message: 'user is already banned' })

    await expect(
      createClient(fetchImpl).banUser('bot-access-token', {
        broadcasterId: '12345',
        moderatorId: 'botのユーザーID',
        userId: '荒らしのユーザーID',
      }),
    ).rejects.toMatchObject({ name: 'TwitchApiError', status: 409 })
  })
})

describe('deleteChatMessage', () => {
  it('メッセージIDを指定して1件だけ削除する', async () => {
    // Twitchは成功時に 204（本文なし）を返す
    const { requests, fetchImpl } = fetchReturningNoBody(204)

    await createClient(fetchImpl).deleteChatMessage('bot-access-token', {
      broadcasterId: '12345',
      moderatorId: 'botのユーザーID',
      messageId: '消したい発言のID',
    })

    const request = requests[0]!
    const url = new URL(request.url)
    expect(url.origin + url.pathname).toBe('https://api.twitch.tv/helix/moderation/chat')
    expect(url.searchParams.get('broadcaster_id')).toBe('12345')
    expect(url.searchParams.get('moderator_id')).toBe('botのユーザーID')
    // message_id を省略するとチャット全体が消えるため、必ず載せる
    expect(url.searchParams.get('message_id')).toBe('消したい発言のID')
    expect(request.method).toBe('DELETE')
  })

  it('Twitchが失敗を返したら TwitchApiError になる', async () => {
    // 配信者や他のモデレーターの発言、6時間より古い発言は削除できない
    const { fetchImpl } = fetchReturning(400, { status: 400, message: 'You may not delete another moderator’s messages.' })

    await expect(
      createClient(fetchImpl).deleteChatMessage('bot-access-token', {
        broadcasterId: '12345',
        moderatorId: 'botのユーザーID',
        messageId: 'モデレーターの発言のID',
      }),
    ).rejects.toMatchObject({ name: 'TwitchApiError', status: 400 })
  })
})

describe('sendChatAnnouncement', () => {
  it('色を指定してアナウンスを送る', async () => {
    const { requests, fetchImpl } = fetchReturningNoBody(204)

    await createClient(fetchImpl).sendChatAnnouncement('bot-access-token', {
      broadcasterId: '12345',
      moderatorId: 'botのユーザーID',
      message: 'たねのぶさんのフォローありがとうございます',
      color: 'purple',
    })

    const request = requests[0]!
    const url = new URL(request.url)
    expect(url.origin + url.pathname).toBe('https://api.twitch.tv/helix/chat/announcements')
    expect(url.searchParams.get('broadcaster_id')).toBe('12345')
    expect(url.searchParams.get('moderator_id')).toBe('botのユーザーID')
    expect(request.method).toBe('POST')
    expect(await request.json()).toEqual({ message: 'たねのぶさんのフォローありがとうございます', color: 'purple' })
  })

  it('色を省略すると primary（チャンネルの色）で送る', async () => {
    const { requests, fetchImpl } = fetchReturningNoBody(204)

    await createClient(fetchImpl).sendChatAnnouncement('bot-access-token', {
      broadcasterId: '12345',
      moderatorId: 'botのユーザーID',
      message: '本日の配信はここまでです',
    })

    expect(await requests[0]!.json()).toEqual({ message: '本日の配信はここまでです', color: 'primary' })
  })

  it('Twitchが失敗を返したら TwitchApiError になる', async () => {
    const { fetchImpl } = fetchReturning(401, { status: 401, message: 'Missing scope: moderator:manage:announcements' })

    await expect(
      createClient(fetchImpl).sendChatAnnouncement('token-without-scope', {
        broadcasterId: '12345',
        moderatorId: 'botのユーザーID',
        message: 'テスト',
      }),
    ).rejects.toMatchObject({ name: 'TwitchApiError', status: 401 })
  })
})

describe('sendShoutout', () => {
  it('シャウトアウトの相手・チャンネル・モデレーターをクエリに載せて送る', async () => {
    const { requests, fetchImpl } = fetchReturningNoBody(204)

    await createClient(fetchImpl).sendShoutout('bot-access-token', {
      broadcasterId: '12345',
      moderatorId: 'botのユーザーID',
      toBroadcasterId: 'レイド元の配信者のユーザーID',
    })

    const request = requests[0]!
    const url = new URL(request.url)
    expect(url.origin + url.pathname).toBe('https://api.twitch.tv/helix/chat/shoutouts')
    expect(url.searchParams.get('from_broadcaster_id')).toBe('12345')
    expect(url.searchParams.get('to_broadcaster_id')).toBe('レイド元の配信者のユーザーID')
    expect(url.searchParams.get('moderator_id')).toBe('botのユーザーID')
    expect(request.method).toBe('POST')
  })

  it('Twitchが失敗を返したら TwitchApiError になる（間隔の制限に当たった場合を含む）', async () => {
    const { fetchImpl } = fetchReturning(429, { status: 429, message: 'shoutout ratelimit exceeded' })

    await expect(
      createClient(fetchImpl).sendShoutout('bot-access-token', {
        broadcasterId: '12345',
        moderatorId: 'botのユーザーID',
        toBroadcasterId: 'レイド元の配信者のユーザーID',
      }),
    ).rejects.toMatchObject({ name: 'TwitchApiError', status: 429 })
  })
})

describe('isModerator', () => {
  it('モデレーターの一覧にそのユーザーが含まれていれば true を返す', async () => {
    const { requests, fetchImpl } = fetchReturning(200, {
      data: [{ user_id: 'botのユーザーID', user_login: 'tanenob_bot', user_name: 'tanenob_bot' }],
      pagination: {},
    })

    const isModerator = await createClient(fetchImpl).isModerator('broadcaster-access-token', {
      broadcasterId: '12345',
      userId: 'botのユーザーID',
    })

    const url = new URL(requests[0]!.url)
    expect(url.origin + url.pathname).toBe('https://api.twitch.tv/helix/moderation/moderators')
    expect(url.searchParams.get('broadcaster_id')).toBe('12345')
    // user_id で絞り込むので、モデレーターが何人いても1件で判定できる
    expect(url.searchParams.get('user_id')).toBe('botのユーザーID')
    expect(isModerator).toBe(true)
  })

  it('一覧が空なら false を返す（モデレーターにされていない）', async () => {
    const { fetchImpl } = fetchReturning(200, { data: [], pagination: {} })

    const isModerator = await createClient(fetchImpl).isModerator('broadcaster-access-token', {
      broadcasterId: '12345',
      userId: 'botのユーザーID',
    })

    expect(isModerator).toBe(false)
  })

  it('応答に data の配列が無ければエラーになる（モデレーターでないと決めつけない）', async () => {
    const { fetchImpl } = fetchReturning(200, { pagination: {} })

    await expect(
      createClient(fetchImpl).isModerator('broadcaster-access-token', { broadcasterId: '12345', userId: 'botのユーザーID' }),
    ).rejects.toBeInstanceOf(TwitchApiError)
  })

  it('スコープが足りなければ TwitchApiError になる', async () => {
    const { fetchImpl } = fetchReturning(401, { status: 401, message: 'Missing scope: moderation:read' })

    await expect(
      createClient(fetchImpl).isModerator('token-without-scope', { broadcasterId: '12345', userId: 'botのユーザーID' }),
    ).rejects.toMatchObject({ name: 'TwitchApiError', status: 401 })
  })
})

describe('startDeviceAuthorization', () => {
  it('スコープを指定してデバイスコードの発行を求め、利用者に見せるコードと案内先を返す', async () => {
    const { requests, fetchImpl } = fetchReturning(200, {
      device_code: 'device-code-0123456789',
      expires_in: 1800,
      interval: 5,
      user_code: 'ABCDEFGH',
      verification_uri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH',
    })

    const authorization = await createClient(fetchImpl).startDeviceAuthorization(['user:bot', 'user:write:chat'])

    expect(authorization).toEqual({
      deviceCode: 'device-code-0123456789',
      userCode: 'ABCDEFGH',
      verificationUri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH',
      expiresIn: 1800,
      intervalSeconds: 5,
    })
    const request = requests[0]!
    expect(request.url).toBe('https://id.twitch.tv/oauth2/device')
    expect(request.method).toBe('POST')
    const form = new URLSearchParams(await request.text())
    expect(form.get('client_id')).toBe('test-client-id')
    expect(form.get('scopes')).toBe('user:bot user:write:chat')
  })

  it('Twitchが失敗を返したら TwitchApiError になる', async () => {
    const { fetchImpl } = fetchReturning(400, { status: 400, message: 'invalid client' })
    await expect(createClient(fetchImpl).startDeviceAuthorization(['user:bot'])).rejects.toMatchObject({
      name: 'TwitchApiError',
      status: 400,
    })
  })

  it('応答に必要な項目が揃っていなければエラーになる', async () => {
    const { fetchImpl } = fetchReturning(200, { device_code: 'device-code-0123456789' })
    await expect(createClient(fetchImpl).startDeviceAuthorization(['user:bot'])).rejects.toBeInstanceOf(TwitchApiError)
  })
})

describe('exchangeDeviceCode', () => {
  it('利用者が認可を済ませていれば、トークンを受け取る', async () => {
    const { requests, fetchImpl } = fetchReturning(200, {
      access_token: 'bot-access-token',
      refresh_token: 'bot-refresh-token',
      expires_in: 14400,
    })

    const result = await createClient(fetchImpl).exchangeDeviceCode('device-code-0123456789', ['user:bot'])

    expect(result).toEqual({
      status: 'granted',
      grant: { accessToken: 'bot-access-token', refreshToken: 'bot-refresh-token', expiresIn: 14400 },
    })
    const form = new URLSearchParams(await requests[0]!.text())
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code')
    expect(form.get('device_code')).toBe('device-code-0123456789')
    expect(form.get('scopes')).toBe('user:bot')
  })

  it('利用者がまだ認可していなければ、失敗ではなく「待っている」状態として返す', async () => {
    // まだ認可していない間、Twitchは400で authorization_pending を返す（RFC 8628）
    const { fetchImpl } = fetchReturning(400, { status: 400, message: 'authorization_pending' })

    expect(await createClient(fetchImpl).exchangeDeviceCode('device-code-0123456789', ['user:bot'])).toEqual({ status: 'pending' })
  })

  it('ポーリングが速すぎると言われたら、待っている状態のうち「間隔を延ばす」ものとして区別して返す', async () => {
    // RFC 8628 では slow_down を受け取った側は、以降の間隔を5秒延ばすことが求められる。
    // authorization_pending と同一視すると、速すぎるまま問い合わせ続けてしまう
    const { fetchImpl } = fetchReturning(400, { status: 400, message: 'slow_down' })

    expect(await createClient(fetchImpl).exchangeDeviceCode('device-code-0123456789', ['user:bot'])).toEqual({ status: 'slow-down' })
  })

  it('コードの期限が切れていたら、待ち続けずにエラーにする', async () => {
    const { fetchImpl } = fetchReturning(400, { status: 400, message: 'expired_token' })

    await expect(createClient(fetchImpl).exchangeDeviceCode('期限切れのコード', ['user:bot'])).rejects.toBeInstanceOf(TwitchApiError)
  })

  it('利用者が認可を断ったら、待ち続けずにエラーにする', async () => {
    const { fetchImpl } = fetchReturning(400, { status: 400, message: 'access_denied' })

    await expect(createClient(fetchImpl).exchangeDeviceCode('device-code-0123456789', ['user:bot'])).rejects.toBeInstanceOf(TwitchApiError)
  })

  it('想定していない失敗は、待っている状態として飲み込まずにエラーにする', async () => {
    const { fetchImpl } = fetchReturning(400, { status: 400, message: 'invalid client' })

    await expect(createClient(fetchImpl).exchangeDeviceCode('device-code-0123456789', ['user:bot'])).rejects.toMatchObject({
      name: 'TwitchApiError',
      status: 400,
    })
  })
})

describe('時間制限（issue #126）', () => {
  it('Twitchが応答を返さないと、待ち続けずに TimeoutError にする', async () => {
    const fetchImpl = (async () => await new Promise<Response>(() => undefined)) as typeof fetch
    const twitch = createTwitchClient({
      clientId: 'test-client-id',
      clientSecret: 'テスト用シークレット',
      fetch: fetchImpl,
      timeoutMs: 10,
    })

    await expect(twitch.getFollowerTotal('test-access-token', '123456')).rejects.toBeInstanceOf(TimeoutError)
  })

  it('外への呼び出しには中断の合図を渡す', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { total: 42, data: [] })

    await createClient(fetchImpl).getFollowerTotal('test-access-token', '123456')
    expect(requests[0]?.signal).toBeInstanceOf(AbortSignal)
  })
})
