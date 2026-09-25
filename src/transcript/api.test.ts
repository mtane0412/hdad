/**
 * 文字起こしの送信（api.ts）のテスト
 *
 * 実際の通信はせず、fetch を差し替える（chat/channel.test.ts と同じ形）。
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../core/api'
import { createTranscriptApi, isRetryable } from './api'

const オーバーレイ用キー = 'overlay-key_0123456789abcdefghij'

/** 呼ばれた内容を記録し、決めた応答を返す fetch */
const 応答を返すfetch = (status: number, body: unknown) => {
  const 呼び出し: { path: string; method: string; body: string }[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    呼び出し.push({ path: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? '') })
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: status === 204 ? {} : { 'Content-Type': 'application/json' },
    })
  }
  return { 呼び出し, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('send', () => {
  it('オーバーレイ用キー付きの経路へ、メッセージIDと本文を送る', async () => {
    const { 呼び出し, fetchImpl } = 応答を返すfetch(200, { recorded: true })

    const recorded = await createTranscriptApi(fetchImpl, オーバーレイ用キー).send('発話1', 'こんばんは、配信を始めます')

    expect(recorded).toBe(true)
    expect(呼び出し).toEqual([
      {
        path: `/api/overlay/transcript?key=${encodeURIComponent(オーバーレイ用キー)}`,
        method: 'POST',
        body: JSON.stringify({ messageId: '発話1', text: 'こんばんは、配信を始めます' }),
      },
    ])
  })

  it('配信していないとWorkerが答えたら、記録されなかったと返す', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { recorded: false })
    expect(await createTranscriptApi(fetchImpl, オーバーレイ用キー).send('独り言', 'マイクの確認です')).toBe(false)
  })

  it('Workerの応答に recorded がなければエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(200, {})
    await expect(createTranscriptApi(fetchImpl, オーバーレイ用キー).send('発話1', 'こんばんは')).rejects.toThrow(/recorded/)
  })

  it('Workerが失敗を返したらエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(401, { error: { code: 'invalid-overlay-key', message: 'オーバーレイ用キーが正しくありません' } })
    await expect(createTranscriptApi(fetchImpl, オーバーレイ用キー).send('発話1', 'こんばんは')).rejects.toThrow(ApiError)
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
