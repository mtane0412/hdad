/**
 * WebMCP の記録を読むツール（record-tools.ts）のテスト
 *
 * Worker の Api の代役を渡してツールを作り、execute を直接呼ぶ。配信の一覧と詳細・視聴者の検索とメモの保存・
 * LLM の使用状況と残高が、画面と同じ Api を通って読み書きされることと、受け付けない入力をエラーにすることを確かめる。
 */
import { describe, expect, it } from 'vitest'
import type { LlmUsageDay } from '@/llm/api'
import type { SessionDetail, SessionSummary } from '@/stats/api'
import type { Viewer, ViewerQuery } from '@/viewers/api'
import { buildRecordTools, type RecordApis } from './record-tools'

/** 試験の時刻（2026-10-07 21:00:00 JST = 12:00 UTC） */
const now = Date.parse('2026-10-07T21:00:00+09:00')

const eveningStream: SessionSummary = {
  id: 'stream-1007',
  startedAt: '2026-10-07T10:00:00Z',
  endedAt: null,
  title: '【作業配信】WebMCP を実装する',
  categoryName: 'Software and Game Development',
  averageViewers: 12,
  peakViewers: 18,
  followerDelta: 2,
  eventCounts: { 'channel.follow': 2 },
}

const eveningStreamDetail: SessionDetail = {
  id: 'stream-1007',
  startedAt: '2026-10-07T10:00:00Z',
  endedAt: null,
  title: '【作業配信】WebMCP を実装する',
  categoryName: 'Software and Game Development',
  samples: [
    { sampledAt: '2026-10-07T10:05:00Z', viewerCount: 10 },
    { sampledAt: '2026-10-07T10:10:00Z', viewerCount: 14 },
  ],
  chapters: [{ startedAt: '2026-10-07T10:00:00Z', endedAt: '2026-10-07T10:30:00Z', title: '段階2のツール', summary: 'チャットの送信をツールにした' }],
  titleCandidates: [{ chapterStartedAt: '2026-10-07T10:00:00Z', candidate: 'ツールを増やす', publishable: 0.82 }],
  summary: 'WebMCP のツールを段階ごとに増やしている',
  workTime: { people: 3, totalMs: 5_400_000 },
}

const regularViewer: Viewer = {
  userId: 'user-1',
  login: 'yoru_no_neko',
  displayName: '夜の猫',
  firstSeenAt: '2026-09-01T12:00:00Z',
  lastSeenAt: '2026-10-07T11:50:00Z',
  messageCount: 120,
  badges: ['subscriber'],
  note: '猫を2匹飼っている',
  summary: '作業配信をよく見に来る',
  summarizedAt: '2026-10-06T15:00:00Z',
  channel: null,
}

/** 箇所ごとの1日ぶんの使用状況（試験用） */
const usageRow = (day: string, usage: string, calls: number, costUsd: number): LlmUsageDay => ({
  day,
  usage,
  provider: 'openrouter',
  model: 'gemini-3.8-flash',
  calls,
  failures: 0,
  promptTokens: calls * 100,
  completionTokens: calls * 10,
  costUsd,
})

/** 試験用の Api。呼ばれ方を記録する */
const createApis = (apiKeyConfigured = true) => {
  const calls = { sessionIds: [] as string[], viewerQueries: [] as ViewerQuery[], notes: [] as { userId: string; note: string }[], credits: 0 }
  const apis: RecordApis = {
    statsApi: {
      sessions: async () => [eveningStream],
      session: async (id) => {
        calls.sessionIds.push(id)
        return eveningStreamDetail
      },
    },
    viewerApi: {
      list: async (query) => {
        calls.viewerQueries.push(query)
        return [regularViewer]
      },
      saveNote: async (userId, note) => {
        calls.notes.push({ userId, note })
        return note.trim()
      },
    },
    llmApi: {
      load: async () => ({ apiKeyConfigured }),
      loadUsage: async () => [usageRow('2026-10-07', 'aiChat', 3, 0.01), usageRow('2026-10-05', 'aiChat', 2, 0.02)],
      loadCredits: async () => {
        calls.credits += 1
        return { totalCredits: 10, totalUsage: 2.5, remaining: 7.5 }
      },
    },
  }
  return { apis, calls }
}

const signal = new AbortController().signal

/** 名前でツールを取り出して実行し、返った文字列を JSON として読む */
const runJson = async (apis: RecordApis, name: string, input: Record<string, unknown> = {}): Promise<unknown> => {
  const result = await run(apis, name, input)
  if (typeof result !== 'string') throw new Error('ツールの結果が文字列ではありません')
  return JSON.parse(result)
}

/** 名前でツールを取り出して実行する */
const run = async (apis: RecordApis, name: string, input: Record<string, unknown> = {}): Promise<unknown> => {
  const tool = buildRecordTools(apis, () => now).find((candidate) => candidate.name === name)
  if (tool === undefined) throw new Error(`${name} というツールがありません`)
  return tool.execute(input, { signal })
}

describe('ツールの一覧', () => {
  it('メモの保存のほかは読むだけで、視聴者の書いた文やそれをもとにした文を返すものには untrustedContentHint を付ける', () => {
    const tools = buildRecordTools(createApis().apis, () => now)
    const hints = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations ?? {}]))
    expect(hints).toEqual({
      list_streams: { readOnlyHint: true },
      get_stream: { readOnlyHint: true, untrustedContentHint: true },
      search_viewers: { readOnlyHint: true, untrustedContentHint: true },
      save_viewer_note: {},
      get_llm_usage: { readOnlyHint: true },
      get_llm_credits: { readOnlyHint: true },
    })
  })
})

describe('配信の記録', () => {
  it('配信の一覧を返す', async () => {
    const { apis } = createApis()
    expect(await runJson(apis, 'list_streams')).toEqual([eveningStream])
  })

  it('配信の詳細を、視聴者数の時系列を除いて返す', async () => {
    const { apis, calls } = createApis()
    const detail = await runJson(apis, 'get_stream', { id: 'stream-1007' })
    // 前提: 時系列は数が多く、平均と最大は list_streams で読めるので返さない
    expect(detail).not.toHaveProperty('samples')
    expect(detail).toMatchObject({
      id: 'stream-1007',
      chapters: eveningStreamDetail.chapters,
      titleCandidates: eveningStreamDetail.titleCandidates,
      summary: 'WebMCP のツールを段階ごとに増やしている',
      workTime: { people: 3, totalMs: 5_400_000 },
    })
    expect(calls.sessionIds).toEqual(['stream-1007'])
  })

  it('id が文字列でなければエラーにする', async () => {
    const { apis, calls } = createApis()
    await expect(run(apis, 'get_stream', { id: 1007 })).rejects.toThrow('id は文字列にしてください')
    expect(calls.sessionIds).toEqual([])
  })
})

describe('視聴者の記録', () => {
  it('渡した条件で検索する', async () => {
    const { apis, calls } = createApis()
    expect(await runJson(apis, 'search_viewers', { search: 'yoru', limit: 10 })).toEqual([regularViewer])
    expect(calls.viewerQueries).toEqual([{ search: 'yoru', limit: 10 }])
  })

  it('条件を省くと、最後に発言した順に Worker の既定の件数を返す', async () => {
    const { apis, calls } = createApis()
    await runJson(apis, 'search_viewers')
    expect(calls.viewerQueries).toEqual([{}])
  })

  it('続きを読む目印も渡せる', async () => {
    const { apis, calls } = createApis()
    await runJson(apis, 'search_viewers', { before: '2026-10-07T11:50:00Z', beforeUserId: 'user-1' })
    expect(calls.viewerQueries).toEqual([{ before: '2026-10-07T11:50:00Z', beforeUserId: 'user-1' }])
  })

  it('条件の型が違えばエラーにする', async () => {
    const { apis, calls } = createApis()
    await expect(run(apis, 'search_viewers', { search: 1 })).rejects.toThrow('search は文字列にしてください')
    await expect(run(apis, 'search_viewers', { limit: '10' })).rejects.toThrow('limit は数にしてください')
    expect(calls.viewerQueries).toEqual([])
  })

  it('メモを保存し、保存された内容を伝える', async () => {
    const { apis, calls } = createApis()
    expect(await run(apis, 'save_viewer_note', { userId: 'user-1', note: ' 猫を3匹飼っている ' })).toBe('メモを保存しました: 猫を3匹飼っている')
    expect(calls.notes).toEqual([{ userId: 'user-1', note: ' 猫を3匹飼っている ' }])
  })

  it('メモの入力が文字列でなければエラーにする', async () => {
    const { apis, calls } = createApis()
    await expect(run(apis, 'save_viewer_note', { userId: 'user-1', note: null })).rejects.toThrow('note は文字列にしてください')
    expect(calls.notes).toEqual([])
  })
})

describe('LLM の使用状況', () => {
  it('今日と直近7日のまとめを返す', async () => {
    const { apis } = createApis()
    const summary = await runJson(apis, 'get_llm_usage')
    expect(summary).toMatchObject({
      total: {
        today: { calls: 3, promptTokens: 300, completionTokens: 30, costUsd: 0.01 },
        week: { calls: 5, promptTokens: 500, completionTokens: 50, costUsd: 0.03 },
      },
      usages: { aiChat: { today: { calls: 3 }, week: { calls: 5 } } },
    })
  })

  it('OpenRouter の残高を返す', async () => {
    const { apis } = createApis()
    expect(await runJson(apis, 'get_llm_credits')).toEqual({ totalCredits: 10, totalUsage: 2.5, remaining: 7.5 })
  })

  it('OpenRouter の鍵が無ければ、残高を読みに行かずにエラーにする', async () => {
    const { apis, calls } = createApis(false)
    await expect(run(apis, 'get_llm_credits')).rejects.toThrow('OpenRouter のAPIキーが設定されていないので、残高を読めません')
    expect(calls.credits).toBe(0)
  })
})
