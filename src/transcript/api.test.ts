/**
 * 文字起こしの送信（api.ts）のテスト
 *
 * 実際の通信はせず、fetch を差し替える（chat/channel.test.ts と同じ形）。
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../core/api'
import { createAppTranscriptApi, isRetryable } from './api'

/** 呼ばれた内容を記録し、決めた応答を返す fetch */
const createFetchWithResponse = (status: number, body: unknown) => {
  const calls: { path: string; method: string; body: string }[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ path: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? '') })
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: status === 204 ? {} : { 'Content-Type': 'application/json' },
    })
  }
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('createAppTranscriptApi の send', () => {
  it('ログインのセッションで守る経路へ、キーを付けずにメッセージIDと本文を送る', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(200, { recorded: true })

    const recorded = await createAppTranscriptApi(fetchImpl).send('webspeech:発話1', 'こんばんは、配信を始めます')

    expect(recorded).toBe(true)
    expect(calls).toEqual([
      {
        path: '/api/admin/transcripts',
        method: 'POST',
        body: JSON.stringify({ messageId: 'webspeech:発話1', text: 'こんばんは、配信を始めます' }),
      },
    ])
  })

  it('Workerの応答に recorded がなければエラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(200, {})
    await expect(createAppTranscriptApi(fetchImpl).send('webspeech:発話1', 'こんばんは')).rejects.toThrow(/recorded/)
  })

  it('配信していないとWorkerが答えたら、記録されなかったと返す', async () => {
    const { fetchImpl } = createFetchWithResponse(200, { recorded: false })
    expect(await createAppTranscriptApi(fetchImpl).send('webspeech:独り言', 'マイクの確認です')).toBe(false)
  })

  it('Workerが失敗を返したらエラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(401, { error: { code: 'unauthorized', message: 'ログインしてください' } })
    await expect(createAppTranscriptApi(fetchImpl).send('webspeech:発話1', 'こんばんは')).rejects.toThrow(ApiError)
  })
})

describe('isRetryable', () => {
  it('通信そのものの失敗はやり直す', () => {
    expect(isRetryable(new TypeError('Failed to fetch'))).toBe(true)
  })

  it('Workerの不具合（5xx）はやり直す', () => {
    expect(isRetryable(new ApiError(500, 'internal-error', '失敗しました', []))).toBe(true)
  })

  it('本文の誤り（400）はやり直さない（同じものを送り直しても同じ答えになるため）', () => {
    expect(isRetryable(new ApiError(400, 'text-too-long', '発話は1000文字までにしてください', []))).toBe(false)
  })

  it('キーの誤り（401）はやり直さない', () => {
    expect(isRetryable(new ApiError(401, 'invalid-overlay-key', 'オーバーレイ用キーが正しくありません', []))).toBe(false)
  })
})
