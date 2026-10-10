/**
 * 意見の振り分けのアラーム（opinion-timer.ts）のテスト
 *
 * 振り分けの間隔は Durable Object（AdBreakTimer の別のインスタンス。名前は opinions）のアラームが刻む。
 * ここでは本物の AdBreakTimer に storage の代役を渡し、次の流れを確かめる（issue #306）。
 * - テーマを開いたら、一定の間隔の後にアラームを仕掛けること
 * - アラームが鳴ったら振り分けの1回分を進め、テーマが開いているあいだは次のアラームを仕掛けること
 * - テーマが締め切られていたら、次のアラームを仕掛けないこと
 * - 止めたらアラームを外すこと
 * - OpenRouter の鍵があれば Jev で絞り込み、無ければ Jev を呼ばないこと（issue #307）
 *
 * D1・アラートの配送先・Workers AI は代役にする。
 */
import { describe, expect, it } from 'vitest'
import type { AdBreakTimerNamespace } from './ad-break-timer'
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
import type { Env } from './http'
import { closeTheme, openTheme, readAdminBoard, recordOpinionComment } from './opinion-store'
import { OPINION_SORT_INTERVAL_MS, startOpinionTimer, stopOpinionTimer } from './opinion-timer'

/** テーマを開いた時刻 */
const openedAt = Date.parse('2026-10-10T12:00:00Z')
/** 意見ボードの Durable Object のインスタンスの名前 */
const TIMER_NAME = 'opinions'

/** 発言 C1 を新しい論点の新しい意見にする応答 */
const newOpinionResponse = JSON.stringify({ results: [{ comments: ['C1'], action: 'new', newTopic: '視聴者との距離', kind: '課題', text: 'AIの返事は寂しい' }] })

/** Jev（OpenRouter の Decisions API）の宛先 */
const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions'

/**
 * テーマを開いて振り分けのアラームを仕掛けた環境を作る。
 *
 * @param openRouterApiKey OpenRouter の鍵。渡すと Jev への通信を受け、発言 C1 を意見である確率 0.9 と答える
 */
const setUp = async (openRouterApiKey?: string) => {
  let current = openedAt
  const alerts = createFakeAlertChannel()
  const env = {
    STORE: createFakeStore(),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    ASSETS: createFakeAssets(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: '12345',
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: alerts.namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: undefined as unknown as AdBreakTimerNamespace,
    TOKENS: createFakeTokenVault().namespace,
    AI: createFakeWorkersAi({ response: newOpinionResponse }),
    OPENROUTER_API_KEY: openRouterApiKey,
  } satisfies Env
  const requested: string[] = []
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    requested.push(String(input))
    if (openRouterApiKey !== undefined && String(input) === DECISIONS_URL) {
      return Response.json({ answers: { C1: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 120, output_tokens: 1, cost: 0.0001 } })
    }
    throw new Error(`テストで想定していない通信です: ${String(input)}`)
  }
  const timers = createTimerInstances(
    () => env,
    { fetch: fetchImpl, now: () => current, wait: async () => {} },
    (at) => {
      current = at
    },
  )
  env.AD_BREAKS = timers.namespace

  const theme = await openTheme(env.DB, '配信中にAIをどこまで使っていい？', openedAt)
  if (theme === null) throw new Error('テーマを開けませんでした')
  await startOpinionTimer(env.AD_BREAKS)
  return { env, alerts, timers, theme, requested }
}

describe('意見の振り分けのアラーム', () => {
  it('始めたら、一定の間隔の後にアラームを仕掛ける', async () => {
    const { timers } = await setUp()
    expect(timers.alarmOf(TIMER_NAME)).toBe(openedAt + OPINION_SORT_INTERVAL_MS)
  })

  it('鳴ったら振り分けを進め、テーマが開いているあいだは次のアラームを仕掛ける', async () => {
    const { env, alerts, timers } = await setUp()
    await recordOpinionComment(
      env.DB,
      { messageId: 'm1', userId: 'id-aoi', userName: 'aoi', text: 'AIのコメ返しはちょっと寂しい', replyName: null, replyText: null, dropReason: null },
      openedAt,
    )

    await timers.ring(TIMER_NAME)

    expect((await readAdminBoard(env.DB)).topics.map(({ title }) => title)).toEqual(['視聴者との距離'])
    expect(alerts.pushedOpinions).toHaveLength(1)
    expect(timers.alarmOf(TIMER_NAME)).toBe(openedAt + OPINION_SORT_INTERVAL_MS * 2)
  })

  it('テーマが締め切られていたら、次のアラームを仕掛けない', async () => {
    const { env, timers, theme } = await setUp()
    await closeTheme(env.DB, theme.id, openedAt + 1000)

    await timers.ring(TIMER_NAME)

    expect(timers.alarmOf(TIMER_NAME)).toBeNull()
  })

  it('OpenRouter の鍵があれば、Jev で絞り込んで確率を残す', async () => {
    const { env, timers, requested } = await setUp('テスト用のOpenRouterの鍵')
    await recordOpinionComment(
      env.DB,
      { messageId: 'm1', userId: 'id-aoi', userName: 'aoi', text: 'AIのコメ返しはちょっと寂しい', replyName: null, replyText: null, dropReason: null },
      openedAt,
    )

    await timers.ring(TIMER_NAME)

    expect(requested).toEqual([DECISIONS_URL])
    expect(env.DB.sqlite.prepare('SELECT jev_score FROM opinion_comments').get()).toEqual({ jev_score: 0.9 })
  })

  it('OpenRouter の鍵が無ければ、Jev を呼ばずに振り分ける', async () => {
    const { env, timers, requested } = await setUp()
    await recordOpinionComment(
      env.DB,
      { messageId: 'm1', userId: 'id-aoi', userName: 'aoi', text: 'AIのコメ返しはちょっと寂しい', replyName: null, replyText: null, dropReason: null },
      openedAt,
    )

    await timers.ring(TIMER_NAME)

    expect(requested).toEqual([])
    expect((await readAdminBoard(env.DB)).topics).toHaveLength(1)
  })

  it('止めたらアラームを外す', async () => {
    const { env, timers } = await setUp()
    await stopOpinionTimer(env.AD_BREAKS)
    expect(timers.alarmOf(TIMER_NAME)).toBeNull()
  })
})
