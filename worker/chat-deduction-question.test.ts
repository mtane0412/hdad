/**
 * チャットで推理の質問の受け口（EventSub の Webhook に届くチャンネルポイントの交換）のテスト
 *
 * Twitch の代わりに署名付きの通知を作り、handleRequest を通して次の点を確かめる（issue #376）。
 * - 「質問」の報酬の交換だけを受け、LLM の答えを D1 に残して交換を FULFILLED にすること
 * - 開催中のゲームが無い・待ち時間の内・LLM の失敗のときは、交換を CANCELED にしてポイントを返すこと
 *   （受け付けなかったときは LLM を呼ばない）
 * - 同じ通知の再送で二重に答えないこと
 * - ほかの報酬・ほかのチャンネルの交換、報酬をまだ作っていないときは何もしないこと
 * - 交換の状態を更新できなかったら、収集の失敗として残すこと
 * - 答えた質問を合成ページへ押し出し、押し出せなくても交換の更新は続けて失敗として残すこと（issue #378）
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { startGame } from './chat-deduction-store'
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
import { listFailures } from './stats-store'
import { saveToken } from './token'

const NOW = Date.parse('2026-10-15T12:00:00.000Z')
const BROADCASTER_ID = '12345'
const SITE = 'https://hdad.example.com'
const SECRET = 'テスト用のWebhookシークレット'
const QUESTION_REWARD_ID = '報酬ID-質問'
const ANSWER_REWARD_ID = '報酬ID-解答'
const REDEMPTIONS_URL = 'https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions'

interface EnvOptions {
  /** LLM（Workers AI）が返す文面 */
  llmText?: string
  /** LLM が失敗する場合 */
  llmShouldFail?: boolean
}

const createEnv = ({ llmText = 'はい\n静岡県と山梨県にまたがっています。', llmShouldFail = false }: EnvOptions = {}) => {
  const ai = createFakeWorkersAi({ response: llmText, shouldFail: llmShouldFail })
  const env = {
    STORE: createFakeStore({ 'overlay-key': 'issued-overlay-key-0123456789abcdefghij' }),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    ASSETS: createFakeAssets(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: BROADCASTER_ID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: SECRET,
    ALERTS: createFakeAlertChannel().namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    TOKENS: createFakeTokenVault().namespace,
    AI: ai,
  } satisfies Env
  return { env, ai }
}

type TestEnv = ReturnType<typeof createEnv>['env']

/** 報酬を作り終え、報酬を書き換えられる配信者のトークンを保管した状態にする */
const prepare = async (env: TestEnv): Promise<void> => {
  await env.STORE.put('chat-deduction-rewards', JSON.stringify({ questionRewardId: QUESTION_REWARD_ID, answerRewardId: ANSWER_REWARD_ID }))
  await saveToken(env.TOKENS, 'broadcaster', {
    accessToken: 'test-access-token',
    refreshToken: 'リフレッシュトークン',
    expiresAt: NOW + 60 * 60 * 1000,
    userId: BROADCASTER_ID,
    login: 'haishinsha',
    scopes: ['channel:read:redemptions', 'channel:manage:redemptions'],
  })
}

/** Twitch の代役。交換の状態の更新（PATCH）を控え、status を写した応答を返す。failStatus を渡すとその状態コードで失敗する */
const fakeTwitch = (failStatus?: number) => {
  const updates: { rewardId: string | null; redemptionId: string | null; status: unknown }[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (request.method === 'PATCH' && url.origin + url.pathname === REDEMPTIONS_URL) {
      if (failStatus !== undefined) return Response.json({ error: 'Not Found', status: failStatus, message: 'redemption not found' }, { status: failStatus })
      const { status } = (await request.json()) as { status: unknown }
      updates.push({ rewardId: url.searchParams.get('reward_id'), redemptionId: url.searchParams.get('id'), status })
      return Response.json({ data: [{ id: url.searchParams.get('id'), status }] })
    }
    throw new Error(`テストで想定していない通信です: ${request.method} ${request.url}`)
  }
  return { updates, fetchImpl }
}

/** 交換の通知の中身。省いた項目は田中太郎さんの「質問」の交換にする */
const redemptionOf = (overrides: Record<string, unknown> = {}) => ({
  subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
  event: {
    id: '交換ID-1',
    broadcaster_user_id: BROADCASTER_ID,
    user_id: '田中太郎のユーザーID',
    user_login: 'tanaka_taro',
    user_name: '田中太郎',
    user_input: '日本にありますか？',
    status: 'unfulfilled',
    reward: { id: QUESTION_REWARD_ID, title: 'チャットで推理: 質問', cost: 100, prompt: '' },
    redeemed_at: '2026-10-15T11:59:59.000Z',
    ...overrides,
  },
})

/** Twitch が送ってくるのと同じ形の、署名付きの通知を作る */
const notificationOf = (body: unknown, messageId = 'message-1'): Request => {
  const timestamp = '2026-10-15T11:59:59.500Z'
  const text = JSON.stringify(body)
  const signature = createHmac('sha256', SECRET).update(messageId + timestamp + text).digest('hex')
  return new Request(`${SITE}/api/eventsub/webhook`, {
    method: 'POST',
    headers: {
      'Twitch-Eventsub-Message-Id': messageId,
      'Twitch-Eventsub-Message-Timestamp': timestamp,
      'Twitch-Eventsub-Message-Signature': `sha256=${signature}`,
      'Twitch-Eventsub-Message-Type': 'notification',
    },
    body: text,
  })
}

/**
 * 通知を Webhook に渡し、応答を返したあとに走らせた処理（LLM の答えと交換の更新）まで待つ。
 *
 * @param now 届いた時刻（待ち時間を確かめるときにずらす）
 */
const deliver = async (env: TestEnv, request: Request, fetchImpl: typeof fetch, now = NOW): Promise<Response> => {
  const deferred: Promise<unknown>[] = []
  const response = await handleRequest(request, env, { fetch: fetchImpl, now: () => now, wait: async () => {}, waitUntil: (promise) => deferred.push(promise) })
  await Promise.all(deferred)
  return response
}

/** D1 に残った質問を古い順に読む */
const storedQuestions = (env: TestEnv) =>
  env.DB.sqlite.prepare('SELECT redemption_id, user_name, question, status, reject_reason, verdict, reply, failure FROM chat_deduction_questions ORDER BY id').all()

describe('チャットで推理の質問の受け口', () => {
  it('開催中のゲームがあれば、LLM の答えを D1 に残して交換を FULFILLED にする', async () => {
    const { env, ai } = createEnv()
    await prepare(env)
    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)
    const twitch = fakeTwitch()

    const response = await deliver(env, notificationOf(redemptionOf()), twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(storedQuestions(env)).toEqual([
      {
        redemption_id: '交換ID-1',
        user_name: '田中太郎',
        question: '日本にありますか？',
        status: 'answered',
        reject_reason: null,
        verdict: 'yes',
        reply: '静岡県と山梨県にまたがっています。',
        failure: null,
      },
    ])
    expect(twitch.updates).toEqual([{ rewardId: QUESTION_REWARD_ID, redemptionId: '交換ID-1', status: 'FULFILLED' }])
    // LLM には問題の事実メモと質問を渡している
    expect(JSON.stringify(ai.calls)).toContain('標高は3776メートル')
    expect(JSON.stringify(ai.calls)).toContain('日本にありますか？')
  })

  it('開催中のゲームが無ければ、LLM を呼ばずに理由を残して交換を CANCELED にする（ポイントを返す）', async () => {
    const { env, ai } = createEnv()
    await prepare(env)
    const twitch = fakeTwitch()

    expect((await deliver(env, notificationOf(redemptionOf()), twitch.fetchImpl)).status).toBe(204)

    expect(storedQuestions(env)).toMatchObject([{ status: 'rejected', reject_reason: 'no-game' }])
    expect(twitch.updates).toEqual([{ rewardId: QUESTION_REWARD_ID, redemptionId: '交換ID-1', status: 'CANCELED' }])
    expect(ai.calls).toHaveLength(0)
  })

  it('同じ人が待ち時間の内に送った質問は、LLM を呼ばずに交換を CANCELED にする', async () => {
    const { env, ai } = createEnv()
    await prepare(env)
    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)
    const twitch = fakeTwitch()
    await deliver(env, notificationOf(redemptionOf()), twitch.fetchImpl)

    await deliver(env, notificationOf(redemptionOf({ id: '交換ID-2', user_input: '山ですか？' }), 'message-2'), twitch.fetchImpl, NOW + 5000)

    expect(storedQuestions(env)).toMatchObject([{ status: 'answered' }, { redemption_id: '交換ID-2', status: 'rejected', reject_reason: 'cooldown' }])
    expect(twitch.updates.map(({ status }) => status)).toEqual(['FULFILLED', 'CANCELED'])
    expect(ai.calls).toHaveLength(1)
  })

  it('LLM が失敗したら、質問を失敗として残し、交換を CANCELED にする', async () => {
    const { env } = createEnv({ llmShouldFail: true })
    await prepare(env)
    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)
    const twitch = fakeTwitch()

    expect((await deliver(env, notificationOf(redemptionOf()), twitch.fetchImpl)).status).toBe(204)

    expect(storedQuestions(env)).toMatchObject([{ status: 'failed', verdict: null, failure: expect.stringContaining('無料枠') }])
    expect(twitch.updates).toEqual([{ rewardId: QUESTION_REWARD_ID, redemptionId: '交換ID-1', status: 'CANCELED' }])
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'chat-deduction-answer-failed' }])
  })

  it('LLM の返事が照合を通らなければ、失敗として残し、交換を CANCELED にする', async () => {
    const { env } = createEnv({ llmText: 'はい\n富士山は静岡県にあります。' })
    await prepare(env)
    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)
    const twitch = fakeTwitch()

    await deliver(env, notificationOf(redemptionOf()), twitch.fetchImpl)

    expect(storedQuestions(env)).toMatchObject([{ status: 'failed', verdict: null, reply: null }])
    expect(twitch.updates.map(({ status }) => status)).toEqual(['CANCELED'])
  })

  it('同じ通知が再送されても、二重に答えず、交換も1回だけ更新する', async () => {
    const { env, ai } = createEnv()
    await prepare(env)
    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)
    const twitch = fakeTwitch()

    await deliver(env, notificationOf(redemptionOf()), twitch.fetchImpl)
    expect((await deliver(env, notificationOf(redemptionOf()), twitch.fetchImpl, NOW + 1000)).status).toBe(204)

    expect(storedQuestions(env)).toHaveLength(1)
    expect(ai.calls).toHaveLength(1)
    expect(twitch.updates).toHaveLength(1)
  })

  it.each([
    { name: 'ほかの報酬', overrides: { reward: { id: '報酬ID-乾杯', title: '乾杯', cost: 100, prompt: '' } } },
    { name: 'ほかのチャンネルの「質問」', overrides: { broadcaster_user_id: '99999' } },
  ])('$name の交換では何もしない', async ({ overrides }) => {
    const { env, ai } = createEnv()
    await prepare(env)
    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)
    const twitch = fakeTwitch()

    expect((await deliver(env, notificationOf(redemptionOf(overrides)), twitch.fetchImpl)).status).toBe(204)

    expect(storedQuestions(env)).toEqual([])
    expect(twitch.updates).toEqual([])
    expect(ai.calls).toHaveLength(0)
  })

  it('報酬をまだ作っていなければ何もしない', async () => {
    const { env } = createEnv()
    const twitch = fakeTwitch()

    expect((await deliver(env, notificationOf(redemptionOf()), twitch.fetchImpl)).status).toBe(204)

    expect(storedQuestions(env)).toEqual([])
    expect(twitch.updates).toEqual([])
  })

  it('「質問」の交換に交換のIDが無ければ400にして、何も残さない（黙って捨てない）', async () => {
    const { env } = createEnv()
    await prepare(env)
    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)

    const response = await deliver(env, notificationOf(redemptionOf({ id: undefined })), fakeTwitch().fetchImpl)

    expect(response.status).toBe(400)
    expect(storedQuestions(env)).toEqual([])
  })

  it('交換を更新できるトークンが無ければ、LLM を呼ばずに質問を失敗として閉じ、収集の失敗を残す', async () => {
    const { env, ai } = createEnv()
    await prepare(env)
    // 報酬を書き換えるスコープ（channel:manage:redemptions）の無いトークンに置き換える
    await saveToken(env.TOKENS, 'broadcaster', {
      accessToken: 'test-access-token',
      refreshToken: 'リフレッシュトークン',
      expiresAt: NOW + 60 * 60 * 1000,
      userId: BROADCASTER_ID,
      login: 'haishinsha',
      scopes: ['channel:read:redemptions'],
    })
    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)
    const twitch = fakeTwitch()

    expect((await deliver(env, notificationOf(redemptionOf()), twitch.fetchImpl)).status).toBe(204)

    expect(ai.calls).toHaveLength(0)
    expect(storedQuestions(env)).toMatchObject([{ status: 'failed', failure: expect.stringContaining('channel:manage:redemptions') }])
    expect(twitch.updates).toEqual([])
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'chat-deduction-redemption-failed' }])
  })

  it('交換の状態を更新できなければ、収集の失敗として残す（D1 の答えは残す）', async () => {
    const { env } = createEnv()
    await prepare(env)
    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)

    expect((await deliver(env, notificationOf(redemptionOf()), fakeTwitch(404).fetchImpl)).status).toBe(204)

    expect(storedQuestions(env)).toMatchObject([{ status: 'answered' }])
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'chat-deduction-redemption-failed', message: expect.stringContaining('404') }])
  })

  it('答えたら、カードの一覧を合成ページへ押し出す（issue #378）', async () => {
    const { env } = createEnv()
    const delivery = createFakeAlertChannel()
    env.ALERTS = delivery.namespace
    await prepare(env)
    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)

    await deliver(env, notificationOf(redemptionOf()), fakeTwitch().fetchImpl)

    expect(delivery.pushedChatDeductions.map(({ cards }) => cards)).toEqual([
      [{ kind: 'question', id: 1, userName: '田中太郎', text: '日本にありますか？', verdict: 'yes', reply: '静岡県と山梨県にまたがっています。' }],
    ])
  })

  it('受け付けなかった・答えられなかった質問では押し出さない（映すものが変わらないため）', async () => {
    const { env } = createEnv({ llmShouldFail: true })
    const delivery = createFakeAlertChannel()
    env.ALERTS = delivery.namespace
    await prepare(env)
    const twitch = fakeTwitch()
    // 開催中のゲームが無いときの質問
    await deliver(env, notificationOf(redemptionOf()), twitch.fetchImpl)
    // LLM が答えられなかった質問
    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)
    await deliver(env, notificationOf(redemptionOf({ id: '交換ID-2' }), 'message-2'), twitch.fetchImpl)

    expect(delivery.pushedChatDeductions).toEqual([])
  })

  it('合成ページへ押し出せなくても、交換は FULFILLED にし、押し出せなかったことを収集の失敗として残す', async () => {
    const { env } = createEnv()
    env.ALERTS = createFakeAlertChannel({ shouldFail: true }).namespace
    await prepare(env)
    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)
    const twitch = fakeTwitch()

    await deliver(env, notificationOf(redemptionOf()), twitch.fetchImpl)

    expect(twitch.updates).toEqual([{ rewardId: QUESTION_REWARD_ID, redemptionId: '交換ID-1', status: 'FULFILLED' }])
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'chat-deduction-push-failed' }])
  })
})
