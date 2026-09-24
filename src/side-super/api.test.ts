/**
 * サイドスーパーの読み出し（api.ts）のテスト
 *
 * 実際の通信はせず、fetch を差し替える（transcript/api.test.ts と同じ形）。
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../core/api'
import { createSideSuperApi } from './api'

const オーバーレイ用キー = 'overlay-key_0123456789abcdefghij'

/** 呼ばれた内容を記録し、決めた応答を返す fetch */
const 応答を返すfetch = (status: number, body: unknown) => {
  const 呼び出し: { path: string; method: string }[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    呼び出し.push({ path: String(input), method: init?.method ?? 'GET' })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { 呼び出し, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('read', () => {
  it('オーバーレイ用キー付きの経路から、いま出す行を読む', async () => {
    const { 呼び出し, fetchImpl } = 応答を返すfetch(200, { lines: ['新作ゲーム', '初見プレイ中'], updatedAt: '2026-09-24T12:00:00.000Z' })

    const 文言 = await createSideSuperApi(fetchImpl, オーバーレイ用キー).read()

    expect(文言).toEqual(['新作ゲーム', '初見プレイ中'])
    expect(呼び出し).toEqual([{ path: `/api/overlay/side-super?key=${encodeURIComponent(オーバーレイ用キー)}`, method: 'GET' }])
  })

  it('配信していない・まだ作っていないときは、空の一覧を返す', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { lines: [], updatedAt: null })

    expect(await createSideSuperApi(fetchImpl, オーバーレイ用キー).read()).toEqual([])
  })

  it('Workerの応答に行の一覧がなければエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { updatedAt: null })

    await expect(createSideSuperApi(fetchImpl, オーバーレイ用キー).read()).rejects.toThrow(/lines/)
  })

  it('行が文字列でなければエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { lines: [1, 2], updatedAt: null })

    await expect(createSideSuperApi(fetchImpl, オーバーレイ用キー).read()).rejects.toThrow(/lines/)
  })

  it('Workerが失敗を返したらエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(401, { error: { code: 'invalid-overlay-key', message: 'オーバーレイ用キーが正しくありません' } })

    await expect(createSideSuperApi(fetchImpl, オーバーレイ用キー).read()).rejects.toThrow(ApiError)
  })
})
