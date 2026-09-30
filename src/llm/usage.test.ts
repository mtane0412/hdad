/**
 * LLMの使用状況のまとめ（usage.ts）のテスト
 *
 * Workerは日ごとの行をそのまま返すので、画面に出す「今日」「直近7日」のまとめはここで作る。
 * 確かめること:
 * - 同じ箇所の行を足し合わせること（提供元やモデルが日の途中で変わっても合算する）
 * - 「今日」はUTCの今日のぶんだけ、「直近7日」は今日を含む7日ぶんを数えること
 * - 7日より前の行は直近7日に入れないこと
 * - 記録が1件も無い箇所も 0 として並ぶこと（画面に穴ができないようにする）
 * - 判定用のモデル Jev の箇所（bgm）も同じようにまとめ、全体の合計に含めること
 */
import { describe, expect, it } from 'vitest'
import { summarizeLlmUsage, type LlmUsageDay } from './usage'

/** UTCで2026-09-27の昼。この時刻を「今」として数える */
const now = Date.parse('2026-09-27T12:00:00.000Z')

/** 1件ぶんの行を作る（書いていない項目は 0） */
const row = (day: string, usage: string, addUsage: Partial<LlmUsageDay> = {}): LlmUsageDay => ({
  day,
  usage,
  provider: 'workers-ai',
  model: '@cf/meta/llama-3.1-8b-instruct-fp8',
  calls: 1,
  failures: 0,
  promptTokens: 100,
  completionTokens: 20,
  costUsd: 0,
  ...addUsage,
})

describe('summarizeLlmUsage', () => {
  it('今日のぶんと直近7日のぶんを、箇所ごとに足し合わせる', async () => {
    const days = [
      row('2026-09-27', 'aiChat'),
      row('2026-09-27', 'aiChat', { model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', failures: 1, calls: 0 }),
      row('2026-09-25', 'aiChat'),
    ]

    const { usages } = summarizeLlmUsage(days, now)

    expect(usages.aiChat.today).toEqual({ calls: 1, failures: 1, promptTokens: 200, completionTokens: 40, costUsd: 0 })
    expect(usages.aiChat.week).toEqual({ calls: 2, failures: 1, promptTokens: 300, completionTokens: 60, costUsd: 0 })
  })

  it('今日を含む7日より前の行は、直近7日に入れない', () => {
    // 2026-09-21 は今日を含めて7日目なので入り、2026-09-20 は入らない
    const days = [row('2026-09-21', 'sideSuper'), row('2026-09-20', 'sideSuper')]

    const { usages } = summarizeLlmUsage(days, now)

    expect(usages.sideSuper.week.calls).toBe(1)
    expect(usages.sideSuper.today.calls).toBe(0)
  })

  it('記録が1件も無い箇所も 0 として並ぶ（画面に穴ができないようにする）', () => {
    const { usages } = summarizeLlmUsage([row('2026-09-27', 'aiChat')], now)

    expect(usages.streamSummary.today).toEqual({ calls: 0, failures: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 })
    expect(usages.viewerSummary.week.calls).toBe(0)
  })

  it('全体の合計も返す（実費の合計を1か所で読めるようにする）', () => {
    const days = [
      row('2026-09-27', 'streamSummary', { provider: 'openrouter', model: 'anthropic/claude-3.5-haiku', costUsd: 0.000_45 }),
      row('2026-09-26', 'aiChat', { costUsd: 0 }),
    ]

    const { total } = summarizeLlmUsage(days, now)

    expect(total.today.costUsd).toBeCloseTo(0.000_45, 8)
    expect(total.week.calls).toBe(2)
  })

  it('Jev の箇所（BGMの選択）もまとめ、全体の合計に含める', () => {
    const days = [row('2026-09-27', 'bgm', { provider: 'openrouter', model: 'typesafe/jev-1.13', calls: 3, promptTokens: 3_000, completionTokens: 30, costUsd: 0.000_12 })]

    const { jevUsages, total } = summarizeLlmUsage(days, now)

    expect(jevUsages.bgm.today).toEqual({ calls: 3, failures: 0, promptTokens: 3_000, completionTokens: 30, costUsd: 0.000_12 })
    expect(total.today.calls).toBe(3)
    expect(total.today.costUsd).toBeCloseTo(0.000_12, 8)
  })

  it('知らない箇所の行は無視する（Workerに箇所が増えても画面が壊れないようにする）', () => {
    const { total } = summarizeLlmUsage([row('2026-09-27', 'unknownUsage')], now)

    expect(total.today.calls).toBe(0)
  })
})
