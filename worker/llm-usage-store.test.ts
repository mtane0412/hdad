/**
 * LLMの使用状況の読み書き（llm-usage-store.ts）のテスト
 *
 * 管理画面（/llm/）に出す「どの箇所でどれだけLLMを使ったか」を、日ごとにまとめて持つ。
 * 確かめるのは次の点である。
 * - 同じ日・同じ箇所・同じモデルの呼び出しは、行を増やさずに足し込むこと
 * - 失敗は calls に混ぜず failures として数えること（無料枠切れの回数を画面から読めるようにするため）
 * - 日・モデルが変われば別の行になること（日の途中でモデルを変えても混ざらない）
 * - 保持期間を過ぎた行が消えること
 * - 読み出しは指定した日以降のぶんだけを、新しい順に返すこと
 */
import { describe, expect, it } from 'vitest'
import { createFakeDatabase } from './fake-database'
import { listLlmUsage, recordLlmUsage, type LlmCallRecord } from './llm-usage-store'

const now = Date.parse('2026-09-27T01:23:45.000Z')
const oneDay = 24 * 60 * 60 * 1000

/** 成功した1回。中身は読んで意味が分かる値にする */
const successfulCall: LlmCallRecord = {
  usage: 'aiChat',
  provider: 'workers-ai',
  model: '@cf/meta/llama-3.1-8b-instruct-fp8',
  promptTokens: 120,
  completionTokens: 30,
  costUsd: 0,
  failed: false,
}

describe('recordLlmUsage', () => {
  it('同じ日の同じ箇所・同じモデルは、行を増やさずに足し込む', async () => {
    const db = createFakeDatabase()

    await recordLlmUsage(db, successfulCall, now)
    await recordLlmUsage(db, successfulCall, now + 60_000)

    const rows = await listLlmUsage(db, '2026-09-01')
    expect(rows).toEqual([
      {
        day: '2026-09-27',
        usage: 'aiChat',
        provider: 'workers-ai',
        model: '@cf/meta/llama-3.1-8b-instruct-fp8',
        calls: 2,
        failures: 0,
        promptTokens: 240,
        completionTokens: 60,
        costUsd: 0,
      },
    ])
  })

  it('失敗は calls に混ぜず failures として数える（無料枠切れの回数を画面から読めるようにするため）', async () => {
    const db = createFakeDatabase()

    await recordLlmUsage(db, successfulCall, now)
    await recordLlmUsage(db, { ...successfulCall, promptTokens: 0, completionTokens: 0, failed: true }, now)

    const [row] = await listLlmUsage(db, '2026-09-01')
    expect(row).toMatchObject({ calls: 1, failures: 1 })
  })

  it('OpenRouter が返した実費は積み上げる', async () => {
    const db = createFakeDatabase()
    const call: LlmCallRecord = { ...successfulCall, provider: 'openrouter', model: 'anthropic/claude-3.5-haiku', costUsd: 0.000_12 }

    await recordLlmUsage(db, call, now)
    await recordLlmUsage(db, call, now)

    const [row] = await listLlmUsage(db, '2026-09-01')
    expect(row?.costUsd).toBeCloseTo(0.000_24, 8)
  })

  it('日・箇所・提供元・モデルが違えば別の行になる（日の途中でモデルを変えても混ざらない）', async () => {
    const db = createFakeDatabase()

    await recordLlmUsage(db, successfulCall, now)
    await recordLlmUsage(db, { ...successfulCall, model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }, now)
    await recordLlmUsage(db, { ...successfulCall, usage: 'streamSummary' }, now)
    await recordLlmUsage(db, successfulCall, now + oneDay)

    expect(await listLlmUsage(db, '2026-09-01')).toHaveLength(4)
  })

  it('保持期間（90日）を過ぎた行は消す', async () => {
    const db = createFakeDatabase()

    await recordLlmUsage(db, successfulCall, now - 91 * oneDay)
    expect(await listLlmUsage(db, '2020-01-01')).toHaveLength(1)

    await recordLlmUsage(db, successfulCall, now)
    expect((await listLlmUsage(db, '2020-01-01')).map(({ day }) => day)).toEqual(['2026-09-27'])
  })
})

describe('listLlmUsage', () => {
  it('指定した日より前の行は返さず、新しい日から順に並べる', async () => {
    const db = createFakeDatabase()

    await recordLlmUsage(db, successfulCall, now - 2 * oneDay)
    await recordLlmUsage(db, successfulCall, now - oneDay)
    await recordLlmUsage(db, successfulCall, now)

    expect((await listLlmUsage(db, '2026-09-26')).map(({ day }) => day)).toEqual(['2026-09-27', '2026-09-26'])
  })
})
