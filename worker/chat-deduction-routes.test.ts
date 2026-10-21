/**
 * チャットで推理の経路（/api/admin/chat-deduction）のテスト
 *
 * KV・D1・Twitchを差し替え、handleRequest を通して次の点を確かめる（issue #375）。
 * - 「質問」「解答」の2つの報酬を、ユーザー入力あり・交換できない状態・待ち行列に入れる形で作り、IDを控えること
 *   （Twitchが交換できるかどうかの切り替えを許すのは、HDADが作った報酬だけであるため）
 * - ゲームを始めたら2つの報酬をONにし、終えたらOFFにすること
 * - 報酬をONにできなければ、ゲームを始めなかったことにして502を返すこと（黙って開催中にしない）
 * - 報酬をOFFにできなければ、ゲームを終えずに502を返すこと（交換できるまま終わったことにしない）
 * - 配信者が選んだ問題集から、直前のゲームと違う問題を Worker が決めて始めること
 * - 知らない問題集・報酬がまだ無い・ほかのゲームが開催中、を見分けて返すこと
 * - チャットで推理の報酬は /rewards/ から削除させないこと
 * - 始めた・終えたゲームを合成ページへ押し出し、押し出せなければ始めた・終えたことを取り消さずに502を返すこと（issue #378）
 * - 合成ページがオーバーレイ用キーで、最後に始めたゲームのカードの一覧を読めること（issue #378）
 * - 場面ごとに鳴らす音の設定を読み書きでき、合成ページへは音声のURLにして一覧と一緒に渡すこと
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CHAT_DEDUCTION_SOUND, loadChatDeductionSound } from './chat-deduction-sound'
import { endGame, readCurrentGame, readLatestGame, startGame } from './chat-deduction-store'
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
import { listFailures } from './stats-store'
import { saveToken } from './token'

const ISSUED_KEY = 'issued-overlay-key-0123456789abcdefghij'
const NOW = Date.parse('2026-10-15T12:00:00.000Z')
const BROADCASTER_ID = '12345'
const ORIGIN = 'https://hdad.example.com'
const MANAGE_SCOPE = 'channel:manage:redemptions'
const QUESTION_REWARD_ID = '報酬ID-質問'
const ANSWER_REWARD_ID = '報酬ID-解答'

const createEnv = () => {
  const env = {
    STORE: createFakeStore({ 'overlay-key': ISSUED_KEY }),
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

// 問題は乱数で決まるので、乱数を0に固定する（「いろいろ」の問題集では先頭の富士山になる）
beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0)
})
afterEach(() => {
  vi.restoreAllMocks()
})

/** 「いろいろ」の問題集でゲームを始める（報酬は作り終えてあり、Twitchは成功を返す。乱数が0なら富士山になる） */
const startFuji = async (env: TestEnv) => {
  await saveRewards(env)
  await saveBroadcasterToken(env)
  const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/games', postJson({ setId: 'misc' })), env, createFakeTwitch().fetchImpl)
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
  it('選んだ問題集から問題を決めてゲームを始め、2つの報酬を交換できるようにする', async () => {
    const env = createEnv()
    await saveRewards(env)
    await saveBroadcasterToken(env)
    const twitch = createFakeTwitch()

    const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/games', postJson({ setId: 'misc' })), env, twitch.fetchImpl)

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ game: { id: 1, problemId: 'mount-fuji', startedAt: '2026-10-15T12:00:00.000Z', endedAt: null, endReason: null } })
    expect(twitch.requests).toEqual([
      { method: 'PATCH', id: QUESTION_REWARD_ID, body: { is_enabled: true } },
      { method: 'PATCH', id: ANSWER_REWARD_ID, body: { is_enabled: true } },
    ])
  })

  it('始めたゲームを、正解の表記を伏せて合成ページへ押し出す', async () => {
    const env = createEnv()
    const delivery = createFakeAlertChannel()
    env.ALERTS = delivery.namespace

    await startFuji(env)

    expect(delivery.pushedChatDeductions).toEqual([
      { game: { id: 1, category: 'place', topic: null, startedAt: '2026-10-15T12:00:00.000Z', endedAt: null, endReason: null, answer: null, explanation: null, image: null }, cards: [], sound: DEFAULT_CHAT_DEDUCTION_SOUND },
    ])
  })

  it('合成ページへ押し出せなければ、ゲームは始めたまま502を返す（報酬はもう交換できるため）', async () => {
    const env = createEnv()
    env.ALERTS = createFakeAlertChannel({ shouldFail: true }).namespace
    await saveRewards(env)
    await saveBroadcasterToken(env)

    const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/games', postJson({ setId: 'misc' })), env, createFakeTwitch().fetchImpl)

    expect(response.status).toBe(502)
    expect((await readError(response)).code).toBe('chat-deduction-push-failed')
    expect((await readCurrentGame(env.DB))?.problemId).toBe('mount-fuji')
  })

  it('直前のゲームの問題は出さず、問題集の残りの問題から選ぶ', async () => {
    const env = createEnv()
    const fuji = await startFuji(env)
    await endGame(env.DB, fuji.id, 'stopped', Date.parse('2026-10-15T12:10:00.000Z'))

    // 乱数は0なので、直前の富士山を除いた「いろいろ」の先頭（夏目漱石）になる
    const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/games', postJson({ setId: 'misc' })), env, createFakeTwitch().fetchImpl)

    expect(response.status).toBe(201)
    expect(((await response.json()) as { game: { problemId: string } }).game.problemId).toBe('natsume-soseki')
  })

  it('知らない問題集なら400を返す（問題のIDを直接指定しても受け付けない）', async () => {
    const env = createEnv()
    await saveRewards(env)

    // 文字列でない setId（toString を潰したもの）でも、文面を作るところで落ちずに400を返す
    for (const body of [{ setId: 'no-such-set' }, { problemId: 'mount-fuji' }, { setId: { toString: null } }]) {
      const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/games', postJson(body)), env)

      expect(response.status).toBe(400)
      expect((await readError(response)).code).toBe('unknown-problem-set')
    }
  })

  it('報酬をまだ作っていなければ409を返す', async () => {
    const env = createEnv()

    const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/games', postJson({ setId: 'misc' })), env)

    expect(response.status).toBe(409)
    expect((await readError(response)).code).toBe('chat-deduction-rewards-missing')
  })

  it('ほかのゲームが開催中なら、Twitchへ送らず409を返す', async () => {
    const env = createEnv()
    await startFuji(env)

    const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/games', postJson({ setId: 'misc' })), env)

    expect(response.status).toBe(409)
    expect((await readError(response)).code).toBe('chat-deduction-game-open')
  })

  it('channel:manage:redemptions の無いトークンしか無ければ、ゲームの行を作らずにログインし直しを求める', async () => {
    const env = createEnv()
    await saveRewards(env)
    await saveBroadcasterToken(env, ['channel:read:redemptions'])

    const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/games', postJson({ setId: 'misc' })), env)

    expect(response.status).toBe(401)
    expect((await readError(response)).code).toBe('missing-scope')
    expect(await readLatestGame(env.DB)).toBeNull()
  })

  it('報酬を交換できるようにできなければ、ゲームを始めなかったことにして502を返す', async () => {
    const env = createEnv()
    await saveRewards(env)
    await saveBroadcasterToken(env)
    const twitch = createFakeTwitch((method) => method === 'PATCH')

    const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/games', postJson({ setId: 'misc' })), env, twitch.fetchImpl)

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

  it('トリガーのチャンネルポイントで始めたゲームなら、始めた報酬も交換できるように戻す', async () => {
    const env = createEnv()
    await saveRewards(env)
    await saveBroadcasterToken(env)
    const game = await startGame(env.DB, 'mount-fuji', NOW, '報酬ID-推理を始める')
    const twitch = createFakeTwitch()

    const response = await invoke(await broadcasterRequest(env, `/api/admin/chat-deduction/games/${game!.id}/end`, { method: 'POST' }), env, twitch.fetchImpl)

    expect(response.status).toBe(200)
    expect(twitch.requests).toEqual([
      { method: 'PATCH', id: QUESTION_REWARD_ID, body: { is_enabled: false } },
      { method: 'PATCH', id: ANSWER_REWARD_ID, body: { is_enabled: false } },
      { method: 'PATCH', id: '報酬ID-推理を始める', body: { is_enabled: true } },
    ])
  })

  it('始めた報酬を交換できるように戻せなくても（報酬が消されたなど）、ゲームは終え、戻せなかったことを記録する（終えられなくしない）', async () => {
    const env = createEnv()
    await saveRewards(env)
    await saveBroadcasterToken(env)
    const game = await startGame(env.DB, 'mount-fuji', NOW, '報酬ID-推理を始める')
    // 交換できるように戻す（is_enabled: true）要求だけを Twitch が断る
    const twitch = createFakeTwitch((_method, body) => body.is_enabled === true)

    const response = await invoke(await broadcasterRequest(env, `/api/admin/chat-deduction/games/${game!.id}/end`, { method: 'POST' }), env, twitch.fetchImpl)

    expect(response.status).toBe(200)
    expect(await readCurrentGame(env.DB)).toBeNull()
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'chat-deduction-rewards-failed' }])
  })

  it('終えたゲームを、正解の表記を添えて合成ページへ押し出す（「正解は富士山でした」を出すため）', async () => {
    const env = createEnv()
    const game = await startFuji(env)
    const delivery = createFakeAlertChannel()
    env.ALERTS = delivery.namespace

    await invoke(await broadcasterRequest(env, `/api/admin/chat-deduction/games/${game.id}/end`, { method: 'POST' }), env, createFakeTwitch().fetchImpl)

    expect(delivery.pushedChatDeductions).toEqual([
      {
        game: { id: game.id, category: 'place', topic: null, startedAt: '2026-10-15T12:00:00.000Z', endedAt: '2026-10-15T12:00:00.000Z', endReason: 'stopped', answer: '富士山', explanation: expect.any(String), image: expect.anything() },
        cards: [],
        sound: DEFAULT_CHAT_DEDUCTION_SOUND,
      },
    ])
  })

  it('合成ページへ押し出せなければ、ゲームは終えたまま502を返す', async () => {
    const env = createEnv()
    const game = await startFuji(env)
    env.ALERTS = createFakeAlertChannel({ shouldFail: true }).namespace

    const response = await invoke(await broadcasterRequest(env, `/api/admin/chat-deduction/games/${game.id}/end`, { method: 'POST' }), env, createFakeTwitch().fetchImpl)

    expect(response.status).toBe(502)
    expect((await readError(response)).code).toBe('chat-deduction-push-failed')
    expect(await readCurrentGame(env.DB)).toBeNull()
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

describe('合成ページのカードの一覧（GET /api/overlay/chat-deduction。issue #378）', () => {
  it('オーバーレイ用キーで、最後に始めたゲームのカードの一覧を読める（開催中は正解の表記を伏せる）', async () => {
    const env = createEnv()
    const game = await startFuji(env)

    const response = await invoke(new Request(`${ORIGIN}/api/overlay/chat-deduction?key=${ISSUED_KEY}`), env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      game: { id: game.id, category: 'place', topic: null, startedAt: '2026-10-15T12:00:00.000Z', endedAt: null, endReason: null, answer: null, explanation: null, image: null },
      cards: [],
      sound: DEFAULT_CHAT_DEDUCTION_SOUND,
    })
  })

  it('音を選んだ枠は、オーバーレイ用キーつきの音声のURLにして一覧と一緒に渡す', async () => {
    // 前提: BGM に音声を選んで保存してある
    const env = createEnv()
    await env.STORE.put('chat-deduction-sound', JSON.stringify({ ...DEFAULT_CHAT_DEDUCTION_SOUND, slots: { ...DEFAULT_CHAT_DEDUCTION_SOUND.slots, bgm: 'media-thinking' } }))

    const response = await invoke(new Request(`${ORIGIN}/api/overlay/chat-deduction?key=${ISSUED_KEY}`), env)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { sound: { slots: { bgm: string | null } } }
    expect(body.sound.slots.bgm).toBe(`/api/media/media-thinking?key=${ISSUED_KEY}`)
  })

  it('キーが違えば401を返す', async () => {
    const env = createEnv()

    const response = await invoke(new Request(`${ORIGIN}/api/overlay/chat-deduction?key=wrong-key`), env)

    expect(response.status).toBe(401)
  })

  it('WebSocket の接続でなければ、配送先へ引き渡さず400を返す', async () => {
    const env = createEnv()

    const response = await invoke(new Request(`${ORIGIN}/api/overlay/chat-deduction/socket?key=${ISSUED_KEY}`), env)

    expect(response.status).toBe(400)
    expect((await readError(response)).code).toBe('expected-websocket')
  })
})

describe('音の設定（GET・PUT /api/admin/chat-deduction/sound）', () => {
  /** 正解の音（音声）と、背景の画像を上げておいた環境 */
  const createEnvWithMedia = async () => {
    const env = createEnv()
    await env.MEDIA.put('media-pinpon', new ArrayBuffer(8), { httpMetadata: { contentType: 'audio/mpeg' }, customMetadata: { name: 'pinpon.mp3' } })
    await env.MEDIA.put('media-haikei', new ArrayBuffer(8), { httpMetadata: { contentType: 'image/png' }, customMetadata: { name: 'haikei.png' } })
    return env
  }

  const putJson = (body: unknown): RequestInit => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  it('ログインしていなければ読ませない', async () => {
    const response = await invoke(new Request(`${ORIGIN}/api/admin/chat-deduction/sound`), createEnv())

    expect(response.status).toBe(401)
  })

  it('未保存なら、どの枠も鳴らさない設定を返す', async () => {
    const env = createEnv()

    const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/sound'), env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(DEFAULT_CHAT_DEDUCTION_SOUND)
  })

  it('保存した設定を返し、次に読んだときも同じものを返す', async () => {
    const env = await createEnvWithMedia()
    const sound = { ...DEFAULT_CHAT_DEDUCTION_SOUND, slots: { ...DEFAULT_CHAT_DEDUCTION_SOUND.slots, correct: 'media-pinpon' }, effectVolume: 0.8 }

    const saved = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/sound', putJson(sound)), env)
    const loaded = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/sound'), env)

    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual(sound)
    expect(await loaded.json()).toEqual(sound)
  })

  it('音声でない素材を選んだ設定は、問題点つきの400で断って保存しない', async () => {
    const env = await createEnvWithMedia()
    const sound = { ...DEFAULT_CHAT_DEDUCTION_SOUND, slots: { ...DEFAULT_CHAT_DEDUCTION_SOUND.slots, start: 'media-haikei' } }

    const response = await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/sound', putJson(sound)), env)

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { problems: string[] } }
    expect(body.error.problems).toEqual(['slots.start: 素材「media-haikei」は音声ではありません'])
    expect(await loadChatDeductionSound(env.STORE)).toEqual(DEFAULT_CHAT_DEDUCTION_SOUND)
  })

  it('音に選ばれている素材は削除させない', async () => {
    // 前提: 正解の音に media-pinpon を選んで保存してある
    const env = await createEnvWithMedia()
    await invoke(await broadcasterRequest(env, '/api/admin/chat-deduction/sound', putJson({ ...DEFAULT_CHAT_DEDUCTION_SOUND, slots: { ...DEFAULT_CHAT_DEDUCTION_SOUND.slots, correct: 'media-pinpon' } })), env)

    const response = await invoke(await broadcasterRequest(env, '/api/admin/media/media-pinpon', { method: 'DELETE' }), env)

    expect(response.status).toBe(409)
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
