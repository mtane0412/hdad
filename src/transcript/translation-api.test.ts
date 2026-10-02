/**
 * 字幕の翻訳の呼び出し（translation-api.ts）のテスト
 *
 * 実際の通信はせず、fetch を差し替える（api.test.ts と同じ形）。
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../core/api'
import { createTranslationApi } from './translation-api'

/** 呼ばれた内容を記録し、決めた応答を返す fetch */
const createFetchWithResponse = (status: number, body: unknown) => {
  const calls: { path: string; method: string; body: string }[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ path: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? '') })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('createTranslationApi の translate', () => {
  it('確定した1件と直前の発話を送り、訳文を受け取る', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(200, { translation: 'Good evening' })

    expect(await createTranslationApi(fetchImpl).translate('こんばんは', ['配信はじめます'])).toBe('Good evening')
    expect(calls).toEqual([
      { path: '/api/admin/translations', method: 'POST', body: JSON.stringify({ text: 'こんばんは', context: ['配信はじめます'] }) },
    ])
  })

  it('訳さない設定なら null を受け取る', async () => {
    const { fetchImpl } = createFetchWithResponse(200, { translation: null })

    expect(await createTranslationApi(fetchImpl).translate('こんばんは', [])).toBeNull()
  })

  it('Workerの応答に translation がなければエラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(200, {})

    await expect(createTranslationApi(fetchImpl).translate('こんばんは', [])).rejects.toThrow(/translation/)
  })

  it('訳せなかったときは、Workerの理由を添えたエラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(502, { error: { code: 'translation-failed', message: '字幕の翻訳に失敗しました: DeepL が失敗を返しました（456）' } })

    await expect(createTranslationApi(fetchImpl).translate('こんばんは', [])).rejects.toBeInstanceOf(ApiError)
  })
})
