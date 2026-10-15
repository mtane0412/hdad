/**
 * チャットで推理の経路（/api/admin/chat-deduction）のテスト
 *
 * KV・D1・Twitchを差し替え、handleRequest を通して次の点を確かめる（issue #375）。
 * - 「質問」「解答」の2つの報酬を、ユーザー入力あり・交換できない状態・待ち行列に入れる形で作り、IDを控えること
 *   （Twitchが交換できるかどうかの切り替えを許すのは、HDADが作った報酬だけであるため）
 * - ゲームを始めたら2つの報酬をONにし、終えたらOFFにすること
 * - 報酬をONにできなければ、ゲームを始めなかったことにして502を返すこと（黙って開催中にしない）
 * - 報酬をOFFにできなければ、ゲームを終えずに502を返すこと（交換できるまま終わったことにしない）
 * - 知らない問題・報酬がまだ無い・ほかのゲームが開催中、を見分けて返すこと
 * - チャットで推理の報酬は /rewards/ から削除させないこと
 */
import { describe, expect, it } from 'vitest'
import { readCurrentGame, readLatestGame } from './chat-deduction-store'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeBucket } from './fake-bucket'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeStore } from './fake-store'
import { createFakeTabChannel } from './fake-tab-channel'
import { createFakeTokenVault } from './fake-token-vault'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'
import { saveToken } from './token'

const NOW = Date.parse('2026-10-15T12:00:00.000Z')
const BROADCASTER_ID = '12345'
const ORIGIN = 'https://hdad.example.com'
const MANAGE_SCOPE = 'channel:manage:redemptions'
const QUESTION_REWARD_ID = '報酬ID-質問'
const ANSWER_REWARD_ID = '報酬ID-解答'

const createEnv = () => {
  const env = {
    STORE: createFakeStore({ 'overlay-key': 'issued-overlay-key-0123456789abcdefghij' }),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    ASSETS: createFakeAssets(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: BROADCASTER_ID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: createFakeAlertChannel().namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    TOKENS: createFakeTokenVault().namespace,
    AI: createFakeWorkersAi(),
  } satisfies Env
  return env
}

type TestEnv = ReturnType<typeof createEnv>

/** 配信者のトークンを保管する。scopes を省くと、報酬の書き換えまでできるトークンになる */
const saveBroadcasterToken = (env: TestEnv, scopes: string[] = ['channel:read:redemptions', MANAGE_SCOPE]) =>
  saveToken(env.TOKENS, 'broadcaster', {
    accessToken: 'test-access-token',
    refreshToken: 'リフレッシュトークン',
    expiresAt: NOW + 60 * 60 * 1000,
    userId: BROADCASTER_ID,
    login: 'haishinsha',
    scopes,
  })

/** 2つの報酬を作り終えた状態にする */
const saveRewards = (env: TestEnv) =>
  env.STORE.put('chat-deduction-rewards', JSON.stringify({ questionRewardId: QUESTION_REWARD_ID, answerRewardId: ANSWER_REWARD_ID }))

/** Twitchが返す報酬（送られた内容をそのまま写す） */
const twitchRewardOf = (id: string, body: Record<string, unknown>) => ({
  id,
  title: 'チャットで推理',
  cost: 100,
  prompt: '',
  is_enabled: false,
  is_user_input_required: true,
  background_color: '#1F6FEB',
  should_redemptions_skip_request_queue: false,
  max_per_stream_setting: { is_enabled: false, max_per_stream: 0 },
  max_per_user_per_stream_setting: { is_enabled: false, max_per_user_per_stream: 0 },
  global_cooldown_setting: { is_enabled: false, global_cooldown_seconds: 0 },
  image: null,
  default_image: { url_1x: 'https://example.com/1.png', url_2x: 'https://example.com/2.png', url_4x: 'https://example.com/4.png' },
  ...body,
})

/**
 * Twitchの報酬の経路の代役。受け取ったリクエストを（本文を読んだ形で）記録する。
 *
 * @param fail 失敗させるリクエストを選ぶ（選ばれたら404を返す）
 */
const createFakeTwitch = (fail: (method: string, body: Record<string, unknown>) => boolean = () => false) => {
  const requests: { method: string; id: string | null; body: Record<string, unknown> | null }[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname !== '/helix/channel_points/custom_rewards') throw new Error(`テストで想定していない通信です: ${request.url}`)
    const body = request.method === 'DELETE' ? null : ((await request.json()) as Record<string, unknown>)
    const id = url.searchParams.get('id')
    requests.push({ method: request.method, id, body })
    if (fail(request.method, body ?? {})) return Response.json({ error: 'Not Found', status: 404, message: 'reward not found' }, { status: 404 })
    if (request.method === 'DELETE') return new Response(null, { status: 204 })
    const createdId = body?.title === 'チャットで推理: 質問' ? QUESTION_REWARD_ID : ANSWER_REWARD_ID
    return Response.json({ data: [twitchRewardOf(id ?? createdId, body ?? {})] })
  }
  return { requests, fetchImpl }
}

const noTwitchFetch = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

const invoke = (request: Request, env: Env, fetchImpl: typeof fetch = noTwitchFetch) =>
  handleRequest(request, env, {
    fetch: fetchImpl,
    now: () => NOW,
    wait: async () => {},
    waitUntil: () => {
      throw new Error('このテストでは、応答のあとに続く処理を使いません')
    },
  })

/** 配信者としてログイン済みのリクエストを作る。書き換えを伴うメソッドには、ブラウザと同じく Origin を付ける */
const broadcasterRequest = async (env: Env, path: string, init: RequestInit = {}): Promise<Request> => {
  const session = await createSessionToken(BROADCASTER_ID, env.SESSION_SECRET, NOW)
  const headers = new Headers(init.headers)
  headers.set('Cookie', `__Host-session=${session}`)
  if (init.method && init.method !== 'GET') headers.set('Origin', ORIGIN)
  return new Request(`${ORIGIN}${path}`, { ...init, headers })
}

const postJson = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

const readError = async (response: Response): Promise<{ code: string; message: string }> =>
  ((await response.json()) as { error: { code: string; message: string } }).error

/** ゲームを始める（報酬は作り終えてあり、Twitchは成功を返す） */
const startFuji = async (env: TestEnv) => {
  await saveRewards(env)
  await saveBroadcasterToken(env)
  const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/games', postJson({ problemId: 'mount-fuji' })), env, createFakeTwitch().fetchImpl)
  expect(response.status).toBe(201)
  return ((await response.json()) as { game: { id: number } }).game
}

describe('チャットで推理の状態（GET /api/admin/chat-deduction）', () => {
  it('セッションがなければ401を返す', async () => {
    const env = createEnv()
    expect((await invoke(new Request(`${ORIGIN}/api/admin/chat-deduction`), env)).status).toBe(401)
  })

  it('報酬を作っておらず、ゲームを一度も始めていなければ、どちらも null を返す', async () => {
    const env = createEnv()

    const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction'), env)

    expect(await response.json()).toEqual({ rewards: null, game: null })
  })

  it('控えた報酬のIDと、最後に始めたゲームを返す', async () => {
    const env = createEnv()
    const game = await startFuji(env)

    const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction'), env)

    expect(await response.json()).toEqual({
      rewards: { questionRewardId: QUESTION_REWARD_ID, answerRewardId: ANSWER_REWARD_ID },
      game: { id: game.id, problemId: 'mount-fuji', startedAt: '2026-10-15T12:00:00.000Z', endedAt: null, endReason: null },
    })
  })
})

describe('報酬の作成（POST /api/admin/chat-deduction/rewards）', () => {
  it('「質問」「解答」の報酬を、ユーザー入力あり・交換できない・待ち行列に入れる形で作り、IDを控える', async () => {
    const env = createEnv()
    await saveBroadcasterToken(env)
    const twitch = createFakeTwitch()

    const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/rewards', { method: 'POST' }), env, twitch.fetchImpl)

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ rewards: { questionRewardId: QUESTION_REWARD_ID, answerRewardId: ANSWER_REWARD_ID } })
    expect(twitch.requests.map(({ method, body }) => [method, body?.title])).toEqual([
      ['POST', 'チャットで推理: 質問'],
      ['POST', 'チャットで推理: 解答'],
    ])
    for (const { body } of twitch.requests) {
      expect(body).toMatchObject({ is_enabled: false, is_user_input_required: true, should_redemptions_skip_request_queue: false })
    }
    expect(JSON.parse((await env.STORE.get('chat-deduction-rewards'))!)).toEqual({ questionRewardId: QUESTION_REWARD_ID, answerRewardId: ANSWER_REWARD_ID })
  })

  it('もう作ってあれば作らず409を返す', async () => {
    const env = createEnv()
    await saveRewards(env)
    await saveBroadcasterToken(env)

    const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/rewards', { method: 'POST' }), env)

    expect(response.status).toBe(409)
    expect((await readError(response)).code).toBe('chat-deduction-rewards-exist')
  })

  it('「解答」を作れなければ、作った「質問」を消して502を返し、何も控えない', async () => {
    const env = createEnv()
    await saveBroadcasterToken(env)
    const twitch = createFakeTwitch((method, body) => method === 'POST' && body.title === 'チャットで推理: 解答')

    const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/rewards', { method: 'POST' }), env, twitch.fetchImpl)

    expect(response.status).toBe(502)
    expect(twitch.requests.at(-1)).toEqual({ method: 'DELETE', id: QUESTION_REWARD_ID, body: null })
    expect(await env.STORE.get('chat-deduction-rewards')).toBeNull()
  })

  it('channel:manage:redemptions の無いトークンしか無ければ、ログインし直しを求める', async () => {
    const env = createEnv()
    await saveBroadcasterToken(env, ['channel:read:redemptions'])

    const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/rewards', { method: 'POST' }), env)

    expect(response.status).toBe(401)
    expect((await readError(response)).code).toBe('missing-scope')
  })
})

describe('ゲームの開始（POST /api/admin/chat-deduction/games）', () => {
  it('ゲームを始め、2つの報酬を交換できるようにする', async () => {
    const env = createEnv()
    await saveRewards(env)
    await saveBroadcasterToken(env)
    const twitch = createFakeTwitch()

    const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/games', postJson({ problemId: 'mount-fuji' })), env, twitch.fetchImpl)

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ game: { id: 1, problemId: 'mount-fuji', startedAt: '2026-10-15T12:00:00.000Z', endedAt: null, endReason: null } })
    expect(twitch.requests).toEqual([
      { method: 'PATCH', id: QUESTION_REWARD_ID, body: { is_enabled: true } },
      { method: 'PATCH', id: ANSWER_REWARD_ID, body: { is_enabled: true } },
    ])
  })

  it('問題集に無い問題なら400を返す', async () => {
    const env = createEnv()
    await saveRewards(env)

    const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/games', postJson({ problemId: 'no-such-problem' })), env)

    expect(response.status).toBe(400)
    expect((await readError(response)).code).toBe('unknown-problem')
  })

  it('報酬をまだ作っていなければ409を返す', async () => {
    const env = createEnv()

    const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/games', postJson({ problemId: 'mount-fuji' })), env)

    expect(response.status).toBe(409)
    expect((await readError(response)).code).toBe('chat-deduction-rewards-missing')
  })

  it('ほかのゲームが開催中なら、Twitchへ送らず409を返す', async () => {
    const env = createEnv()
    await startFuji(env)

    const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/games', postJson({ problemId: 'natsume-soseki' })), env)

    expect(response.status).toBe(409)
    expect((await readError(response)).code).toBe('chat-deduction-game-open')
  })

  it('報酬を交換できるようにできなければ、ゲームを始めなかったことにして502を返す', async () => {
    const env = createEnv()
    await saveRewards(env)
    await saveBroadcasterToken(env)
    const twitch = createFakeTwitch((method) => method === 'PATCH')

    const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/games', postJson({ problemId: 'mount-fuji' })), env, twitch.fetchImpl)

    expect(response.status).toBe(502)
    expect(await readLatestGame(env.DB)).toBeNull()
  })
})

describe('ゲームの終了（POST /api/admin/chat-deduction/games/:id/end）', () => {
  it('2つの報酬を交換できないようにしてから、配信者が打ち切ったとしてゲームを終える', async () => {
    const env = createEnv()
    const game = await startFuji(env)
    const twitch = createFakeTwitch()

    const response = await invoke(await broadcasterRequest(env, `/api/admin/chat-deduction/games/${game.id}/end`, { method: 'POST' }), env, twitch.fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ game: { id: game.id, problemId: 'mount-fuji', startedAt: '2026-10-15T12:00:00.000Z', endedAt: '2026-10-15T12:00:00.000Z', endReason: 'stopped' } })
    expect(twitch.requests).toEqual([
      { method: 'PATCH', id: QUESTION_REWARD_ID, body: { is_enabled: false } },
      { method: 'PATCH', id: ANSWER_REWARD_ID, body: { is_enabled: false } },
    ])
  })

  it('開催中でないゲームなら、Twitchへ送らず404を返す', async () => {
    const env = createEnv()
    await saveRewards(env)

    const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/games/1/end', { method: 'POST' }), env)

    expect(response.status).toBe(404)
  })

  it('報酬を交換できないようにできなければ、ゲームを終えずに502を返す（やり直せるように）', async () => {
    const env = createEnv()
    const game = await startFuji(env)
    const twitch = createFakeTwitch((method) => method === 'PATCH')

    const response = await invoke(await broadcasterRequest(env, `/api/admin/chat-deduction/games/${game.id}/end`, { method: 'POST' }), env, twitch.fetchImpl)

    expect(response.status).toBe(502)
    expect((await readCurrentGame(env.DB))?.id).toBe(game.id)
  })
})

describe('チャットで推理の報酬の削除（DELETE /api/admin/rewards/:id）', () => {
  it('チャットで推理の報酬は、Twitchへ送らず409で断る', async () => {
    const env = createEnv()
    await saveRewards(env)
    await saveBroadcasterToken(env)

    const response = await invoke(await broadcasterRequest(env, `/api/admin/rewards/${encodeURIComponent(ANSWER_REWARD_ID)}`, { method: 'DELETE' }), env)

    expect(response.status).toBe(409)
    expect((await readError(response)).code).toBe('reward-in-use')
  })
})
