/**
 * チャットで推理の制限時間（chat-deduction-timer.ts）のテスト
 *
 * 制限時間を設定してゲームを始めると、締め切りの時刻を Durable Object（AdBreakTimer の別のインスタンス。名前は chat-deduction）に預け、
 * アラームで起こしてもらう。ここでは本物の AdBreakTimer に storage の代役を渡し、次の流れを確かめる。
 * - 締め切りに開催中なら、ゲームを時間切れ（timeout）で終え、2つの報酬を交換できないようにし、正解を添えて合成ページへ押し出す
 * - トリガーのチャンネルポイントで始めたゲームなら、始めた報酬を交換できるように戻す
 * - 締め切りまでに正解・打ち切りで終えていれば何もしない（終わり方を書き換えず、Twitch も呼ばない）
 * - 報酬を交換できないようにできなくても、ゲームは時間切れで終えたまま、失敗として記録する
 * - 制限時間がなしなら、締め切りを預けない
 *
 * KV・D1・Twitch・アラートの配送先は代役にする。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { endGame, readLatestGame, startGame } from './chat-deduction-store'
import { scheduleChatDeductionTimeout } from './chat-deduction-timer'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeBucket } from './fake-bucket'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeStore } from './fake-store'
import { createFakeTabChannel } from './fake-tab-channel'
import { createTimerInstances } from './fake-timer-instances'
import { createFakeTokenVault } from './fake-token-vault'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'
import { listFailures } from './stats-store'
import { saveToken } from './token'

/** ゲームを始めた時刻 */
const NOW = Date.parse('2026-10-27T12:00:00.000Z')
/** 15分の制限時間で始めたときの締め切り */
const CLOSES_AT = NOW + 15 * 60 * 1000
const BROADCASTER_ID = '12345'
const ORIGIN = 'https://hdad.example.com'
const QUESTION_REWARD_ID = '報酬ID-質問'
const ANSWER_REWARD_ID = '報酬ID-解答'
/** トリガーのチャンネルポイントで始めたときの、始めた報酬 */
const START_REWARD_ID = '報酬ID-推理を始める'
/** チャットで推理の Durable Object のインスタンスの名前 */
const TIMER_NAME = 'chat-deduction'

/** Twitch の報酬の経路の代役。受け取った切り替え（報酬のIDと is_enabled）を記録する。fail が真なら404を返す */
const createFakeTwitch = (fail = false) => {
  const toggles: { id: string | null; isEnabled: unknown }[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname !== '/helix/channel_points/custom_rewards' || request.method !== 'PATCH') throw new Error(`テストで想定していない通信です: ${request.method} ${request.url}`)
    const body = (await request.json()) as Record<string, unknown>
    toggles.push({ id: url.searchParams.get('id'), isEnabled: body.is_enabled })
    if (fail) return Response.json({ error: 'Not Found', status: 404, message: 'reward not found' }, { status: 404 })
    return Response.json({
      data: [
        {
          id: url.searchParams.get('id'),
          title: 'チャットで推理',
          cost: 100,
          prompt: '',
          is_enabled: body.is_enabled,
          is_user_input_required: true,
          background_color: '#1F6FEB',
          should_redemptions_skip_request_queue: false,
          max_per_stream_setting: { is_enabled: false, max_per_stream: 0 },
          max_per_user_per_stream_setting: { is_enabled: false, max_per_user_per_stream: 0 },
          global_cooldown_setting: { is_enabled: false, global_cooldown_seconds: 0 },
          image: null,
          default_image: { url_1x: 'https://example.com/1.png', url_2x: 'https://example.com/2.png', url_4x: 'https://example.com/4.png' },
        },
      ],
    })
  }
  return { toggles, fetchImpl }
}

/**
 * 報酬を作り終え、配信者のトークンを保管した環境を作る。
 *
 * @param options.minutes 保存しておく制限時間。null なら未保存（なし）
 * @param options.failTwitch Twitch が報酬の切り替えを失敗で返す
 */
const setUp = async ({ minutes = 15, failTwitch = false }: { minutes?: number | null; failTwitch?: boolean } = {}) => {
  let current = NOW
  const twitch = createFakeTwitch(failTwitch)
  const alerts = createFakeAlertChannel()
  const dependencies = { fetch: twitch.fetchImpl, now: () => current, wait: async () => {} }
  const timers = createTimerInstances(() => env, dependencies, (at) => {
    current = at
  })
  const env = {
    STORE: createFakeStore({
      'overlay-key': 'issued-overlay-key-0123456789abcdefghij',
      'chat-deduction-rewards': JSON.stringify({ questionRewardId: QUESTION_REWARD_ID, answerRewardId: ANSWER_REWARD_ID }),
      ...(minutes === null ? {} : { 'chat-deduction-time-limit': JSON.stringify({ minutes }) }),
    }),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    ASSETS: createFakeAssets(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: BROADCASTER_ID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: alerts.namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: timers.namespace,
    TOKENS: createFakeTokenVault().namespace,
    AI: createFakeWorkersAi(),
  } satisfies Env
  await saveToken(env.TOKENS, 'broadcaster', {
    accessToken: 'test-access-token',
    refreshToken: 'リフレッシュトークン',
    expiresAt: NOW + 60 * 60 * 1000,
    userId: BROADCASTER_ID,
    login: 'haishinsha',
    scopes: ['channel:read:redemptions', 'channel:manage:redemptions'],
  })
  return { env, twitch, alerts, timers }
}

/** 配信者として /chat-deduction/ のページから「いろいろ」の問題集でゲームを始める（乱数が0なら富士山になる） */
const startFromPage = async ({ env, twitch }: Awaited<ReturnType<typeof setUp>>) => {
  const session = await createSessionToken(BROADCASTER_ID, env.SESSION_SECRET, NOW)
  const request = new Request(`${ORIGIN}/api/admin/chat-deduction/games`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `__Host-session=${session}`, Origin: ORIGIN },
    body: JSON.stringify({ setId: 'misc' }),
  })
  return handleRequest(request, env, {
    fetch: twitch.fetchImpl,
    now: () => NOW,
    wait: async () => {},
    waitUntil: () => {
      throw new Error('このテストでは、応答のあとに続く処理を使いません')
    },
  })
}

beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('チャットで推理の制限時間', () => {
  it('制限時間を設定して始めると、締め切りの時刻をゲームに控え、その時刻にアラームを仕掛ける', async () => {
    const setup = await setUp({ minutes: 15 })

    const response = await startFromPage(setup)

    expect(response.status).toBe(201)
    expect(((await response.json()) as { game: { closesAt: string } }).game.closesAt).toBe('2026-10-27T12:15:00.000Z')
    expect(setup.timers.alarmOf(TIMER_NAME)).toBe(CLOSES_AT)
  })

  it('制限時間がなしなら、締め切りを控えず、アラームも仕掛けない', async () => {
    const setup = await setUp({ minutes: null })

    const response = await startFromPage(setup)

    expect(((await response.json()) as { game: { closesAt: string | null } }).game.closesAt).toBeNull()
    expect(setup.timers.alarmOf(TIMER_NAME)).toBeNull()
  })

  it('締め切りに開催中なら、時間切れで終え、2つの報酬を交換できないようにし、正解を添えて合成ページへ押し出す', async () => {
    const setup = await setUp()
    await startFromPage(setup)
    setup.twitch.toggles.length = 0

    await setup.timers.ring(TIMER_NAME)

    const game = await readLatestGame(setup.env.DB)
    expect(game?.endReason).toBe('timeout')
    expect(game?.endedAt).toBe('2026-10-27T12:15:00.000Z')
    expect(setup.twitch.toggles).toEqual([
      { id: QUESTION_REWARD_ID, isEnabled: false },
      { id: ANSWER_REWARD_ID, isEnabled: false },
    ])
    const pushed = setup.alerts.pushedChatDeductions.at(-1)
    expect(pushed?.game?.endReason).toBe('timeout')
    expect(pushed?.game?.answer).toBe('富士山')
  })

  it('トリガーのチャンネルポイントで始めたゲームなら、時間切れで終えたあと始めた報酬を交換できるように戻す', async () => {
    const setup = await setUp()
    const game = await startGame(setup.env.DB, 'mount-fuji', NOW, START_REWARD_ID, CLOSES_AT)
    await scheduleChatDeductionTimeout(setup.env.AD_BREAKS, { gameId: game!.id, closesAt: CLOSES_AT })

    await setup.timers.ring(TIMER_NAME)

    expect(setup.twitch.toggles).toContainEqual({ id: START_REWARD_ID, isEnabled: true })
    expect((await readLatestGame(setup.env.DB))?.endReason).toBe('timeout')
  })

  it('締め切りまでに打ち切りで終えていれば、終わり方を書き換えず、Twitch も呼ばない', async () => {
    const setup = await setUp()
    await startFromPage(setup)
    const started = await readLatestGame(setup.env.DB)
    await endGame(setup.env.DB, started!.id, 'stopped', NOW + 60 * 1000)
    setup.twitch.toggles.length = 0

    await setup.timers.ring(TIMER_NAME)

    expect((await readLatestGame(setup.env.DB))?.endReason).toBe('stopped')
    expect(setup.twitch.toggles).toEqual([])
  })

  it('報酬を交換できないようにできなくても、ゲームは時間切れで終えたまま、失敗として記録する', async () => {
    const setup = await setUp({ failTwitch: true })
    const game = await startGame(setup.env.DB, 'mount-fuji', NOW, null, CLOSES_AT)
    await scheduleChatDeductionTimeout(setup.env.AD_BREAKS, { gameId: game!.id, closesAt: CLOSES_AT })

    await setup.timers.ring(TIMER_NAME)

    expect((await readLatestGame(setup.env.DB))?.endReason).toBe('timeout')
    expect((await listFailures(setup.env.DB)).map(({ code }) => code)).toContain('chat-deduction-rewards-failed')
  })
})
