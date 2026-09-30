/**
 * OpenRouter の残高（llm-credits.ts）のテスト
 *
 * 管理画面（/llm/）に「いくら付与されていて、いくら使ったか」を出すために読む。確かめるのは次の点である。
 * - 鍵を Authorization ヘッダーに付けて公開APIへ問い合わせること
 * - 付与額と使用額を読み、残りを差で出すこと
 * - OpenRouter が失敗を返した・応答の形が違うときは、0 を返さずに投げること（Fail-Fast）
 */
import { describe, expect, it } from 'vitest'
import { readOpenRouterCredits } from './llm-credits'

/** 渡されたリクエストを控え、決めた応答を返す fetch */
const fakeFetch = (response: Response): typeof fetch & { called: Request[] } => {
  const called: Request[] = []
  const impl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    called.push(new Request(input as RequestInfo, init))
    return Promise.resolve(response)
  }
  return Object.assign(impl as typeof fetch, { called })
}

describe('readOpenRouterCredits', () => {
  it('鍵を付けて問い合わせ、付与額・使用額・残りを返す', async () => {
    const fetchImpl = fakeFetch(Response.json({ data: { total_credits: 10, total_usage: 2.5 } }))

    const credits = await readOpenRouterCredits({ fetch: fetchImpl, apiKey: 'openrouter-test-key' })

    expect(credits).toEqual({ totalCredits: 10, totalUsage: 2.5, remaining: 7.5 })
    const request = fetchImpl.called[0]
    if (request === undefined) throw new Error('OpenRouter へ問い合わせていません')
    expect(request.url).toBe('https://openrouter.ai/api/v1/credits')
    expect(request.headers.get('Authorization')).toBe('Bearer openrouter-test-key')
  })

  it('OpenRouter が失敗を返したら、状態コードを添えて投げる（残高を 0 と見せない）', async () => {
    const fetchImpl = fakeFetch(new Response('{"error":{"message":"No auth credentials found"}}', { status: 401 }))

    await expect(readOpenRouterCredits({ fetch: fetchImpl, apiKey: 'openrouter-expired-key' })).rejects.toThrow(/401/)
  })

  it('応答の形が違えば投げる', async () => {
    const fetchImpl = fakeFetch(Response.json({ data: {} }))

    await expect(readOpenRouterCredits({ fetch: fetchImpl, apiKey: 'openrouter-test-key' })).rejects.toThrow('残高')
  })
})
