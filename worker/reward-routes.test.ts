/**
 * チャンネルポイント報酬の経路（/api/admin/rewards）のテスト
 *
 * KV・R2・D1とTwitchを差し替え、handleRequest を通して確かめる。特に重要なのは次の点。
 * - 一覧に、HDADから変更できる報酬かどうか（manageable）を添えること（Twitchは他のアプリが作った報酬の変更を拒むため）
 * - 作成・更新は入力を検証してからTwitchへ送り、問題点を400の応答に並べて返すこと
 * - 書き換えには channel:manage:redemptions が要り、無ければログインし直しを求めること
 * - トリガーに使われている報酬は削除させないこと（配信中にアラートが黙って出なくなるのを防ぐ）
 * - セッションが無ければ使えないこと
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
import { saveToken } from './token'

const now = Date.UTC(2026, 8, 30, 12, 0, 0)
const broadcasterId = '12345'
const origin = 'https://hdad.example.com'

const MANAGE_SCOPE = 'channel:manage:redemptions'

const createEnv = () => {
  const store = createFakeStore({ 'overlay-key': 'issued-overlay-key-0123456789abcdefghij' })
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

/** 配信者のトークンを保管する。scopes を省くと、報酬の書き換えまでできるトークンになる */
const saveBroadcasterToken = (store: ReturnType<typeof createFakeStore>, scopes: string[] = ['channel:read:redemptions', MANAGE_SCOPE]) =>
  saveToken(store, 'broadcaster', {
    accessToken: 'test-access-token',
    refreshToken: 'リフレッシュトークン',
    expiresAt: now + 60 * 60 * 1000,
    userId: broadcasterId,
    login: 'haishinsha',
    scopes,
  })

/** Twitchが用意している既定の報酬画像 */
const defaultImage = { url_1x: 'https://static-cdn.jtvnw.net/custom-reward-images/default-1.png', url_2x: 'https://static-cdn.jtvnw.net/custom-reward-images/default-2.png', url_4x: 'https://static-cdn.jtvnw.net/custom-reward-images/default-4.png' }

/** Twitchが返す報酬（HDADが作ったもの） */
const toastReward = {
  id: '報酬ID-乾杯',
  title: '乾杯する',
  cost: 500,
  prompt: 'おつまみも添えて',
  is_enabled: true,
  is_user_input_required: false,
  image: null,
  default_image: defaultImage,
}

/** Twitchが返す報酬（Twitchのダッシュボードで作ったもの。HDADからは変更できない） */
const hydrateReward = {
  id: '報酬ID-水分補給',
  title: '水分補給させる',
  cost: 100,
  prompt: '',
  is_enabled: true,
  is_user_input_required: false,
  image: null,
  default_image: defaultImage,
}

/** 管理画面が送る報酬の内容 */
const rewardInput = { title: '乾杯する', cost: 500, prompt: 'おつまみも添えて', isEnabled: true, isUserInputRequired: false }

/** Twitchの代役。報酬の経路にだけ答え、受け取ったリクエストを記録する */
const createFakeTwitch = (respond: (request: Request) => Response | Promise<Response>) => {
  const requests: Request[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    if (new URL(request.url).pathname !== '/helix/channel_points/custom_rewards') {
      throw new Error(`テストで想定していない通信です: ${request.url}`)
    }
    requests.push(request.clone())
    return respond(request)
  }
  return { requests, fetchImpl }
}

const noTwitchFetch = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

const noWait = async (): Promise<void> => {}

/** これらの経路は応答のあとに続く処理（waitUntil）を使わない */
const noDefer = (): void => {
  throw new Error('このテストでは、応答のあとに続く処理を使いません')
}

const invoke = (request: Request, env: Env, fetchImpl: typeof fetch = noTwitchFetch) =>
  handleRequest(request, env, { fetch: fetchImpl, now: () => now, wait: noWait, waitUntil: noDefer })

/** 配信者としてログイン済みのリクエストを作る。書き換えを伴うメソッドには、ブラウザと同じく Origin を付ける */
const broadcasterRequest = async (env: Env, path: string, init: RequestInit = {}): Promise<Request> => {
  const session = await createSessionToken(broadcasterId, env.SESSION_SECRET, now)
  const headers = new Headers(init.headers)
  headers.set('Cookie', `__Host-session=${session}`)
  if (init.method && init.method !== 'GET' && !headers.has('Origin')) headers.set('Origin', origin)
  return new Request(`${origin}${path}`, { ...init, headers })
}

/** JSONの本文を付けたリクエストの設定 */
const jsonBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const readError = async (response: Response): Promise<{ code: string; message: string; problems?: string[] }> =>
  ((await response.json()) as { error: { code: string; message: string; problems?: string[] } }).error

describe('チャンネルポイント報酬の一覧（GET /api/admin/rewards）', () => {
  it('セッションがなければ401を返す', async () => {
    const { env } = createEnv()
    expect((await invoke(new Request(`${origin}/api/admin/rewards`), env)).status).toBe(401)
  })

  it('すべての報酬を返し、HDADから変更できる報酬にだけ manageable を立てる', async () => {
    const { env, store } = createEnv()
    await saveBroadcasterToken(store, ['channel:read:redemptions'])
    const twitch = createFakeTwitch((request) => {
      const onlyManageable = new URL(request.url).searchParams.get('only_manageable_rewards') === 'true'
      return Response.json({ data: onlyManageable ? [toastReward] : [toastReward, hydrateReward] })
    })

    const response = await invoke(await broadcasterRequest(env, '/api/admin/rewards'), env, twitch.fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      rewards: [
        { ...rewardInput, id: '報酬ID-乾杯', imageUrl: 'https://static-cdn.jtvnw.net/custom-reward-images/default-2.png', manageable: true },
        { id: '報酬ID-水分補給', title: '水分補給させる', cost: 100, prompt: '', isEnabled: true, isUserInputRequired: false, imageUrl: 'https://static-cdn.jtvnw.net/custom-reward-images/default-2.png', manageable: false },
      ],
    })
    expect(new URL(twitch.requests[0]!.url).searchParams.get('broadcaster_id')).toBe(broadcasterId)
    expect(twitch.requests[0]!.headers.get('Authorization')).toBe('Bearer test-access-token')
  })

  it('Twitchが失敗を返したら、502でTwitchのメッセージを伝える', async () => {
    const { env, store } = createEnv()
    await saveBroadcasterToken(store)
    const twitch = createFakeTwitch(() => Response.json({ message: 'channel points are not available' }, { status: 403 }))

    const response = await invoke(await broadcasterRequest(env, '/api/admin/rewards'), env, twitch.fetchImpl)

    expect(response.status).toBe(502)
    expect((await readError(response)).code).toBe('twitch-error')
  })
})

describe('チャンネルポイント報酬の作成（POST /api/admin/rewards）', () => {
  it('入力を検証してTwitchで報酬を作り、作られた報酬を201で返す', async () => {
    const { env, store } = createEnv()
    await saveBroadcasterToken(store)
    const twitch = createFakeTwitch(() => Response.json({ data: [toastReward] }))

    const response = await invoke(await broadcasterRequest(env, '/api/admin/rewards', jsonBody('POST', rewardInput)), env, twitch.fetchImpl)

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ ...rewardInput, id: '報酬ID-乾杯', imageUrl: 'https://static-cdn.jtvnw.net/custom-reward-images/default-2.png', manageable: true })
    expect(twitch.requests[0]!.method).toBe('POST')
    expect(await twitch.requests[0]!.json()).toMatchObject({ title: '乾杯する', cost: 500 })
  })

  it('入力に問題があれば、Twitchへ送らずに問題点を並べた400を返す', async () => {
    const { env, store } = createEnv()
    await saveBroadcasterToken(store)

    const response = await invoke(await broadcasterRequest(env, '/api/admin/rewards', jsonBody('POST', { ...rewardInput, title: '', cost: 0 })), env)

    expect(response.status).toBe(400)
    const error = await readError(response)
    expect(error.code).toBe('invalid-config')
    expect(error.problems).toHaveLength(2)
  })

  it('トークンに channel:manage:redemptions が無ければ、Twitchへ送らずにログインし直しを求める', async () => {
    const { env, store } = createEnv()
    await saveBroadcasterToken(store, ['channel:read:redemptions'])

    const response = await invoke(await broadcasterRequest(env, '/api/admin/rewards', jsonBody('POST', rewardInput)), env)

    expect(response.status).toBe(401)
    const error = await readError(response)
    expect(error.code).toBe('missing-scope')
    expect(error.message).toContain(MANAGE_SCOPE)
  })

  it('本文がJSONでなければ400を返す', async () => {
    const { env, store } = createEnv()
    await saveBroadcasterToken(store)

    const response = await invoke(await broadcasterRequest(env, '/api/admin/rewards', { method: 'POST', body: '乾杯する' }), env)

    expect(response.status).toBe(400)
  })

  it('送信元が違えば、Twitchへ送らずに断る（CSRF対策）', async () => {
    const { env, store } = createEnv()
    await saveBroadcasterToken(store)

    const request = await broadcasterRequest(env, '/api/admin/rewards', {
      ...jsonBody('POST', rewardInput),
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    })
    const response = await invoke(request, env)

    expect(response.status).toBe(403)
  })
})

describe('チャンネルポイント報酬の更新（PATCH /api/admin/rewards/:id）', () => {
  it('報酬のIDを指定してTwitchで更新し、更新後の報酬を返す', async () => {
    const { env, store } = createEnv()
    await saveBroadcasterToken(store)
    const twitch = createFakeTwitch(() => Response.json({ data: [{ ...toastReward, cost: 800 }] }))

    const response = await invoke(
      await broadcasterRequest(env, `/api/admin/rewards/${encodeURIComponent('報酬ID-乾杯')}`, jsonBody('PATCH', { ...rewardInput, cost: 800 })),
      env,
      twitch.fetchImpl,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ...rewardInput, cost: 800, id: '報酬ID-乾杯', imageUrl: 'https://static-cdn.jtvnw.net/custom-reward-images/default-2.png', manageable: true })
    expect(twitch.requests[0]!.method).toBe('PATCH')
    expect(new URL(twitch.requests[0]!.url).searchParams.get('id')).toBe('報酬ID-乾杯')
  })

  it('入力に問題があれば、Twitchへ送らずに400を返す', async () => {
    const { env, store } = createEnv()
    await saveBroadcasterToken(store)

    const response = await invoke(
      await broadcasterRequest(env, '/api/admin/rewards/報酬ID-乾杯', jsonBody('PATCH', { ...rewardInput, prompt: 'あ'.repeat(201) })),
      env,
    )

    expect(response.status).toBe(400)
  })

  it('HDADが作っていない報酬ではTwitchが拒むので、502でTwitchのメッセージを伝える', async () => {
    const { env, store } = createEnv()
    await saveBroadcasterToken(store)
    const twitch = createFakeTwitch(() => Response.json({ message: 'The client-id does not match' }, { status: 403 }))

    const response = await invoke(
      await broadcasterRequest(env, '/api/admin/rewards/報酬ID-水分補給', jsonBody('PATCH', rewardInput)),
      env,
      twitch.fetchImpl,
    )

    expect(response.status).toBe(502)
    expect((await readError(response)).message).toContain('client-id does not match')
  })
})

describe('チャンネルポイント報酬の削除（DELETE /api/admin/rewards/:id）', () => {
  it('報酬のIDを指定してTwitchで削除し、204を返す', async () => {
    const { env, store } = createEnv()
    await saveBroadcasterToken(store)
    const twitch = createFakeTwitch(() => new Response(null, { status: 204 }))

    const response = await invoke(await broadcasterRequest(env, '/api/admin/rewards/報酬ID-乾杯', { method: 'DELETE' }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(twitch.requests[0]!.method).toBe('DELETE')
    expect(new URL(twitch.requests[0]!.url).searchParams.get('id')).toBe('報酬ID-乾杯')
  })

  it('トリガーに使われている報酬は、Twitchへ送らずに409で断る', async () => {
    const { env, store } = createEnv()
    await saveBroadcasterToken(store)
    await store.put(
      'alert-config',
      JSON.stringify({ triggers: [{ kind: 'reward', rewardId: '報酬ID-乾杯', actions: [{ type: 'chat', message: '{user} さん、乾杯！' }] }] }),
    )

    const response = await invoke(await broadcasterRequest(env, '/api/admin/rewards/報酬ID-乾杯', { method: 'DELETE' }), env)

    expect(response.status).toBe(409)
    expect((await readError(response)).code).toBe('reward-in-use')
  })

  it('トークンに channel:manage:redemptions が無ければ、Twitchへ送らずにログインし直しを求める', async () => {
    const { env, store } = createEnv()
    await saveBroadcasterToken(store, ['channel:read:redemptions'])

    const response = await invoke(await broadcasterRequest(env, '/api/admin/rewards/報酬ID-乾杯', { method: 'DELETE' }), env)

    expect(response.status).toBe(401)
    expect((await readError(response)).code).toBe('missing-scope')
  })
})
