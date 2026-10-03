/**
 * 作業机の読み出し（api.ts）のテスト
 *
 * 実際の通信はせず、fetch を差し替える（work-log/api.test.ts と同じ形）。
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../core/api'
import { createTaskDeskApi } from './api'

const OVERLAY_KEY = 'overlay-key_0123456789abcdefghij'

/** 呼ばれた内容を記録し、決めた応答を返す fetch */
const createFetchWithResponse = (status: number, body: unknown) => {
  const calls: string[] = []
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input))
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('read', () => {
  it('オーバーレイ用キー付きの経路から、いまの配信の作業机を読む', async () => {
    const working = { userId: '11111', name: 'たなか', task: '英単語を50個覚える', declaredAt: '2026-10-03T12:10:00.000Z', doneAt: null }
    const workTime = { people: 1, totalMs: 30 * 60 * 1000, working: 1, measuredAt: '2026-10-03T12:40:00.000Z' }
    const { calls, fetchImpl } = createFetchWithResponse(200, { entries: [working], workTime })

    expect(await createTaskDeskApi(fetchImpl, OVERLAY_KEY).read()).toEqual({ entries: [working], workTime })
    expect(calls).toEqual([`/api/overlay/task-desk?key=${encodeURIComponent(OVERLAY_KEY)}`])
  })

  it('行の形が違えばエラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(200, { entries: [{ userId: '11111', name: 'たなか' }], workTime: null })

    await expect(createTaskDeskApi(fetchImpl, OVERLAY_KEY).read()).rejects.toThrow(/entries/)
  })

  it('作業した時間の合計の形が違えばエラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(200, { entries: [], workTime: { people: 1 } })

    await expect(createTaskDeskApi(fetchImpl, OVERLAY_KEY).read()).rejects.toThrow(/workTime/)
  })

  it('Workerが失敗を返したらエラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(401, { error: { code: 'invalid-overlay-key', message: 'オーバーレイ用キーが正しくありません' } })

    await expect(createTaskDeskApi(fetchImpl, OVERLAY_KEY).read()).rejects.toThrow(ApiError)
  })
})
