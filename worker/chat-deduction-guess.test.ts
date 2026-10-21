/**
 * チャットで推理の解答の受け口（EventSub の Webhook に届くチャンネルポイントの交換）のテスト
 *
 * Twitch の代わりに署名付きの通知を作り、handleRequest を通して次の点を確かめる（issue #377）。
 * - 正解の解答で、正解者を1人に決めてゲームを終え、2つの報酬を交換できないようにし、交換を FULFILLED にすること
 * - 不正解の解答も記録し、交換を FULFILLED にすること（ゲームは続く）
 * - 開催中でないとき・正解のあとに届いた解答は、交換を CANCELED にしてポイントを返すこと
 * - 同じ通知の再送で二重に照合しないこと
 * - 報酬を交換できないようにできなかったら、収集の失敗として残すこと（ゲームは終えたまま、交換は更新する）
 * - 正解者に渡す人形を選んでいれば、正解者にいまの人形を1つ渡すこと。渡せなくてもゲームは終え、失敗として残すこと（issue #420）
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { readGame, startGame } from './chat-deduction-store'
import { saveDollPrize } from './doll-prize'
import { insertDollSet, readDollHoldings, selectCurrentDollSet } from './doll-store'
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
const CUSTOM_REWARDS_PATH = '/helix/channel_points/custom_rewards'
const REDEMPTIONS_PATH = '/helix/channel_points/custom_rewards/redemptions'

const createEnv = () =>
  ({
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
    AI: createFakeWorkersAi({ response: 'テストでは LLM を呼ばない' }),
  }) satisfies Env

type TestEnv = ReturnType<typeof createEnv>

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

/** Twitchが返す報酬（交換できるかどうかだけを写す） */
const twitchRewardOf = (id: string, isEnabled: unknown) => ({
  id,
  title: 'チャットで推理',
  cost: 300,
  prompt: '',
  is_enabled: isEnabled,
  is_user_input_required: true,
  background_color: '#1F6FEB',
  should_redemptions_skip_request_queue: false,
  max_per_stream_setting: { is_enabled: false, max_per_stream: 0 },
  max_per_user_per_stream_setting: { is_enabled: false, max_per_user_per_stream: 0 },
  global_cooldown_setting: { is_enabled: false, global_cooldown_seconds: 0 },
  image: null,
  default_image: { url_1x: 'https://example.com/1.png', url_2x: 'https://example.com/2.png', url_4x: 'https://example.com/4.png' },
})

/**
 * Twitch の代役。報酬の切り替え（PATCH custom_rewards）と交換の状態の更新（PATCH redemptions）を控える。
 *
 * @param failRewards 報酬の切り替えを404で失敗させる場合
 */
const fakeTwitch = ({ failRewards = false } = {}) => {
  const rewardSwitches: { rewardId: string | null; isEnabled: unknown }[] = []
  const updates: { rewardId: string | null; redemptionId: string | null; status: unknown }[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (request.method === 'PATCH' && url.pathname === REDEMPTIONS_PATH) {
      const { status } = (await request.json()) as { status: unknown }
      updates.push({ rewardId: url.searchParams.get('reward_id'), redemptionId: url.searchParams.get('id'), status })
      return Response.json({ data: [{ id: url.searchParams.get('id'), status }] })
    }
    if (request.method === 'PATCH' && url.pathname === CUSTOM_REWARDS_PATH) {
      if (failRewards) return Response.json({ error: 'Not Found', status: 404, message: 'reward not found' }, { status: 404 })
      const { is_enabled: isEnabled } = (await request.json()) as { is_enabled: unknown }
      rewardSwitches.push({ rewardId: url.searchParams.get('id'), isEnabled })
      return Response.json({ data: [twitchRewardOf(url.searchParams.get('id') ?? '', isEnabled)] })
    }
    throw new Error(`テストで想定していない通信です: ${request.method} ${request.url}`)
  }
  return { rewardSwitches, updates, fetchImpl }
}

/** 解答の交換の通知の中身。省いた項目は田中太郎さんの「富士山」という解答にする */
const guessOf = (overrides: Record<string, unknown> = {}) => ({
  subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
  event: {
    id: '交換ID-1',
    broadcaster_user_id: BROADCASTER_ID,
    user_id: '田中太郎のユーザーID',
    user_login: 'tanaka_taro',
    user_name: '田中太郎',
    user_input: '富士山',
    status: 'unfulfilled',
    reward: { id: ANSWER_REWARD_ID, title: 'チャットで推理: 解答', cost: 300, prompt: '' },
    redeemed_at: '2026-10-15T11:59:59.000Z',
    ...overrides,
  },
})

/** 鈴木花子さんの解答の交換の通知の中身 */
const suzukiGuessOf = (redemptionId: string, guess: string) =>
  guessOf({ id: redemptionId, user_id: '鈴木花子のユーザーID', user_login: 'suzuki_hanako', user_name: '鈴木花子', user_input: guess })

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

/** 通知を Webhook に渡し、応答を返したあとに走らせた処理（照合と交換の更新）まで待つ */
const deliver = async (env: TestEnv, request: Request, fetchImpl: typeof fetch, now = NOW): Promise<Response> => {
  const deferred: Promise<unknown>[] = []
  const response = await handleRequest(request, env, { fetch: fetchImpl, now: () => now, wait: async () => {}, waitUntil: (promise) => deferred.push(promise) })
  await Promise.all(deferred)
  return response
}

/** D1 に残った解答を古い順に読む */
const storedGuesses = (env: TestEnv) =>
  env.DB.sqlite.prepare('SELECT redemption_id, user_name, guess, status, reject_reason FROM chat_deduction_guesses ORDER BY id').all()

describe('チャットで推理の解答の受け口', () => {
  it('正解なら、ゲームを solved で終え、2つの報酬を交換できないようにして、交換を FULFILLED にする', async () => {
    const env = createEnv()
    await prepare(env)
    const game = await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)
    const twitch = fakeTwitch()

    // 表記の揺れ（カタカナ・前後の空白）があっても、別名と揃えて照合する
    const response = await deliver(env, notificationOf(guessOf({ user_input: ' フジサン ' })), twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(storedGuesses(env)).toEqual([{ redemption_id: '交換ID-1', user_name: '田中太郎', guess: ' フジサン ', status: 'correct', reject_reason: null }])
    expect(await readGame(env.DB, game!.id)).toMatchObject({ endReason: 'solved', endedAt: '2026-10-15T12:00:00.000Z' })
    expect(twitch.rewardSwitches).toEqual([
      { rewardId: QUESTION_REWARD_ID, isEnabled: false },
      { rewardId: ANSWER_REWARD_ID, isEnabled: false },
    ])
    expect(twitch.updates).toEqual([{ rewardId: ANSWER_REWARD_ID, redemptionId: '交換ID-1', status: 'FULFILLED' }])
  })

  it('トリガーのチャンネルポイントで始めたゲームが正解で終わったら、始めた報酬も交換できるように戻す', async () => {
    const env = createEnv()
    await prepare(env)
    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000, '報酬ID-推理を始める')
    const twitch = fakeTwitch()

    await deliver(env, notificationOf(guessOf({ user_input: '富士山' })), twitch.fetchImpl)

    expect(twitch.rewardSwitches).toEqual([
      { rewardId: QUESTION_REWARD_ID, isEnabled: false },
      { rewardId: ANSWER_REWARD_ID, isEnabled: false },
      { rewardId: '報酬ID-推理を始める', isEnabled: true },
    ])
  })

  it('不正解なら、記録して交換を FULFILLED にし、ゲームは続ける（報酬は切り替えない）', async () => {
    const env = createEnv()
    await prepare(env)
    const game = await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)
    const twitch = fakeTwitch()

    await deliver(env, notificationOf(guessOf({ user_input: '阿蘇山' })), twitch.fetchImpl)

    expect(storedGuesses(env)).toMatchObject([{ guess: '阿蘇山', status: 'wrong' }])
    expect(await readGame(env.DB, game!.id)).toMatchObject({ endedAt: null, endReason: null })
    expect(twitch.rewardSwitches).toEqual([])
    expect(twitch.updates).toEqual([{ rewardId: ANSWER_REWARD_ID, redemptionId: '交換ID-1', status: 'FULFILLED' }])
  })

  it('開催中のゲームが無ければ、理由 no-game で残し、交換を CANCELED にする（ポイントを返す）', async () => {
    const env = createEnv()
    await prepare(env)
    const twitch = fakeTwitch()

    await deliver(env, notificationOf(guessOf()), twitch.fetchImpl)

    expect(storedGuesses(env)).toMatchObject([{ status: 'rejected', reject_reason: 'no-game' }])
    expect(twitch.updates).toEqual([{ rewardId: ANSWER_REWARD_ID, redemptionId: '交換ID-1', status: 'CANCELED' }])
  })

  it('正解のあとに届いた解答は、正解でも交換を CANCELED にする（正解者は最初の1人だけ）', async () => {
    const env = createEnv()
    await prepare(env)
    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)
    const twitch = fakeTwitch()
    await deliver(env, notificationOf(guessOf()), twitch.fetchImpl)

    await deliver(env, notificationOf(suzukiGuessOf('交換ID-2', '富士山'), 'message-2'), twitch.fetchImpl, NOW + 1000)

    expect(storedGuesses(env)).toMatchObject([
      { user_name: '田中太郎', status: 'correct' },
      { user_name: '鈴木花子', status: 'rejected', reject_reason: 'no-game' },
    ])
    expect(twitch.updates.map(({ status }) => status)).toEqual(['FULFILLED', 'CANCELED'])
  })

  it('同じ通知が再送されても、二重に照合せず、交換も1回だけ更新する', async () => {
    const env = createEnv()
    await prepare(env)
    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)
    const twitch = fakeTwitch()

    await deliver(env, notificationOf(guessOf()), twitch.fetchImpl)
    expect((await deliver(env, notificationOf(guessOf()), twitch.fetchImpl, NOW + 1000)).status).toBe(204)

    expect(storedGuesses(env)).toHaveLength(1)
    expect(twitch.updates).toHaveLength(1)
  })

  it('報酬を交換できないようにできなければ、収集の失敗として残す（ゲームは終えたまま、交換は FULFILLED にする）', async () => {
    const env = createEnv()
    await prepare(env)
    const game = await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)
    const twitch = fakeTwitch({ failRewards: true })

    await deliver(env, notificationOf(guessOf()), twitch.fetchImpl)

    expect(await readGame(env.DB, game!.id)).toMatchObject({ endReason: 'solved' })
    expect(twitch.updates).toEqual([{ rewardId: ANSWER_REWARD_ID, redemptionId: '交換ID-1', status: 'FULFILLED' }])
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'chat-deduction-rewards-failed', message: expect.stringContaining('404') }])
  })

  it('正解でゲームを終えたあとにトークンを取れなければ、報酬を止められなかったことも収集の失敗として残す', async () => {
    const env = createEnv()
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
    const game = await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)
    const twitch = fakeTwitch()

    await deliver(env, notificationOf(guessOf()), twitch.fetchImpl)

    // 正解者はトークンの有無にかかわらず決まる
    expect(await readGame(env.DB, game!.id)).toMatchObject({ endReason: 'solved' })
    expect(twitch.rewardSwitches).toEqual([])
    expect((await listFailures(env.DB)).map(({ code }) => code).sort()).toEqual(['chat-deduction-redemption-failed', 'chat-deduction-rewards-failed'])
  })

  it('「解答」の交換に解答の文字列が無ければ400にして、何も残さない（黙って捨てない）', async () => {
    const env = createEnv()
    await prepare(env)
    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)

    const response = await deliver(env, notificationOf(guessOf({ user_input: undefined })), fakeTwitch().fetchImpl)

    expect(response.status).toBe(400)
    expect(storedGuesses(env)).toEqual([])
  })

  it('不正解なら、不正解のカードを合成ページへ押し出す（issue #378）', async () => {
    const env = createEnv()
    const delivery = createFakeAlertChannel()
    env.ALERTS = delivery.namespace
    await prepare(env)
    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)

    await deliver(env, notificationOf(guessOf({ user_input: '阿蘇山' })), fakeTwitch().fetchImpl)

    expect(delivery.pushedChatDeductions).toMatchObject([
      { game: { endedAt: null, answer: null }, cards: [{ kind: 'guess', id: 1, userName: '田中太郎', text: '阿蘇山', correct: false }] },
    ])
  })

  it('正解なら、正解のカードと正解の表記を合成ページへ押し出す（「正解は富士山でした」を出すため）', async () => {
    const env = createEnv()
    const delivery = createFakeAlertChannel()
    env.ALERTS = delivery.namespace
    await prepare(env)
    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)

    await deliver(env, notificationOf(guessOf()), fakeTwitch().fetchImpl)

    expect(delivery.pushedChatDeductions).toMatchObject([
      { game: { endReason: 'solved', answer: '富士山' }, cards: [{ kind: 'guess', userName: '田中太郎', text: '富士山', correct: true }] },
    ])
  })

  it('受け付けなかった解答では押し出さない（映すものが変わらないため）', async () => {
    const env = createEnv()
    const delivery = createFakeAlertChannel()
    env.ALERTS = delivery.namespace
    await prepare(env)

    await deliver(env, notificationOf(guessOf()), fakeTwitch().fetchImpl)

    expect(delivery.pushedChatDeductions).toEqual([])
  })

  it('合成ページへ押し出せなくても、交換は FULFILLED にし、押し出せなかったことを収集の失敗として残す', async () => {
    const env = createEnv()
    env.ALERTS = createFakeAlertChannel({ shouldFail: true }).namespace
    await prepare(env)
    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)
    const twitch = fakeTwitch()

    await deliver(env, notificationOf(guessOf({ user_input: '阿蘇山' })), twitch.fetchImpl)

    expect(twitch.updates).toEqual([{ rewardId: ANSWER_REWARD_ID, redemptionId: '交換ID-1', status: 'FULFILLED' }])
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'chat-deduction-push-failed' }])
  })
})

describe('チャットで推理の正解者に渡す人形（issue #420）', () => {
  /** クマの人形の組を登録し、いまの人形に選ぶ */
  const selectBears = async (env: TestEnv): Promise<number> => {
    const set = await insertDollSet(
      env.DB,
      { normal: { name: 'クマ人形', mediaId: 'image-bear' }, super: { name: 'スーパークマ人形', mediaId: 'image-super-bear' } },
      NOW - 24 * 60 * 60 * 1000,
    )
    await selectCurrentDollSet(env.DB, set.id)
    return set.id
  }

  it('正解者に渡す人形を選んでいれば、正解者にいまの人形を1つ渡し、理由をチャットで推理として台帳に残す', async () => {
    // 前提: 正解者に渡すのはスーパー人形。いまの人形はクマの組
    const env = createEnv()
    await prepare(env)
    await saveDollPrize(env.STORE, 'chatDeduction', { kind: 'super' })
    const setId = await selectBears(env)
    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)

    await deliver(env, notificationOf(guessOf()), fakeTwitch().fetchImpl)

    expect(await readDollHoldings(env.DB)).toEqual([{ userId: '田中太郎のユーザーID', setId, normal: 0, super: 1 }])
    expect(env.DB.sqlite.prepare('SELECT reason, trigger_kind FROM doll_ledger').all()).toEqual([{ reason: 'chatDeduction', trigger_kind: null }])
  })

  it('不正解の人と、正解のあとに届いた正解の人には渡さない', async () => {
    const env = createEnv()
    await prepare(env)
    await saveDollPrize(env.STORE, 'chatDeduction', { kind: 'normal' })
    const setId = await selectBears(env)
    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)
    const twitch = fakeTwitch()

    await deliver(env, notificationOf(suzukiGuessOf('交換ID-1', '阿蘇山'), 'message-1'), twitch.fetchImpl)
    await deliver(env, notificationOf(guessOf({ id: '交換ID-2' }), 'message-2'), twitch.fetchImpl)
    await deliver(env, notificationOf(suzukiGuessOf('交換ID-3', '富士山'), 'message-3'), twitch.fetchImpl)

    // 渡したのは最初に正解した田中太郎さんの1つだけ
    expect(await readDollHoldings(env.DB)).toEqual([{ userId: '田中太郎のユーザーID', setId, normal: 1, super: 0 }])
  })

  it('次のゲームの正解者にも渡す（ゲームごとに1回ずつ渡す）', async () => {
    const env = createEnv()
    await prepare(env)
    await saveDollPrize(env.STORE, 'chatDeduction', { kind: 'normal' })
    const setId = await selectBears(env)
    const twitch = fakeTwitch()

    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)
    await deliver(env, notificationOf(guessOf({ id: '交換ID-1' }), 'message-1'), twitch.fetchImpl)
    await startGame(env.DB, 'mount-fuji', NOW - 30 * 1000)
    await deliver(env, notificationOf(guessOf({ id: '交換ID-2' }), 'message-2'), twitch.fetchImpl)

    expect(await readDollHoldings(env.DB)).toEqual([{ userId: '田中太郎のユーザーID', setId, normal: 2, super: 0 }])
  })

  it('渡す人形が「なし」（保存していない）なら、正解しても渡さない', async () => {
    const env = createEnv()
    await prepare(env)
    await selectBears(env)
    await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)

    await deliver(env, notificationOf(guessOf()), fakeTwitch().fetchImpl)

    expect(await readDollHoldings(env.DB)).toEqual([])
    expect(await listFailures(env.DB)).toEqual([])
  })

  it('いまの人形が選ばれていなくても、ゲームは正解で終えて交換を FULFILLED にし、渡せなかったことを失敗として残す', async () => {
    // 前提: 正解者に渡す人形は選んであるが、いまの人形を選んでいない
    const env = createEnv()
    await prepare(env)
    await saveDollPrize(env.STORE, 'chatDeduction', { kind: 'normal' })
    const game = await startGame(env.DB, 'mount-fuji', NOW - 60 * 1000)
    const twitch = fakeTwitch()

    await deliver(env, notificationOf(guessOf()), twitch.fetchImpl)

    expect(await readGame(env.DB, game!.id)).toMatchObject({ endReason: 'solved' })
    expect(twitch.updates).toEqual([{ rewardId: ANSWER_REWARD_ID, redemptionId: '交換ID-1', status: 'FULFILLED' }])
    expect(await readDollHoldings(env.DB)).toEqual([])
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'doll-grant-failed', message: expect.stringContaining('いまの人形が選ばれていません') }])
  })
})
