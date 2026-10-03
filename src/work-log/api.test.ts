/**
 * 作業ログの読み出し（api.ts）のテスト
 *
 * 実際の通信はせず、fetch を差し替える（side-super/api.test.ts と同じ形）。
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../core/api'
import { createWorkLogApi } from './api'

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
  it('オーバーレイ用キー付きの経路から、いまの配信の作業ログを読む', async () => {
    const merged = { id: 'github:delivery-1', kind: 'merge', at: '2026-10-03T12:40:00.000Z', text: '#212 GitHub の Webhook を受ける' }
    const { calls, fetchImpl } = createFetchWithResponse(200, { entries: [merged] })

    expect(await createWorkLogApi(fetchImpl, OVERLAY_KEY).read()).toEqual([merged])
    expect(calls).toEqual([`/api/overlay/work-log?key=${encodeURIComponent(OVERLAY_KEY)}`])
  })

  it('行の形が違えばエラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(200, { entries: [{ id: 'github:delivery-1', kind: 'merge' }] })

    await expect(createWorkLogApi(fetchImpl, OVERLAY_KEY).read()).rejects.toThrow(/entries/)
  })

  it('Workerが失敗を返したらエラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(401, { error: { code: 'invalid-overlay-key', message: 'オーバーレイ用キーが正しくありません' } })

    await expect(createWorkLogApi(fetchImpl, OVERLAY_KEY).read()).rejects.toThrow(ApiError)
  })
})
