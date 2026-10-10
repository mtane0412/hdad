/**
 * 意見ボードの Worker の呼び出し（api.ts）のテスト
 *
 * 実際の通信はせず、fetch を差し替える。合成ページの読み出し（オーバーレイ用キー）と、
 * アプリのページ（/opinions/）の読み書きの両方を確かめる。
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../core/api'
import { createOpinionApi, createOpinionOverlayApi, type AdminOpinionBoard } from './api'
import type { OpinionBoard } from './entry'

const OVERLAY_KEY = 'overlay-key_0123456789abcdefghij'
const theme = { id: 1, title: '配信中にAIをどこまで使っていい？', openedAt: '2026-10-10T12:00:00.000Z', closedAt: null }
const overlayBoard: OpinionBoard = {
  theme,
  topics: [{ id: 1, title: '視聴者との距離', opinions: [{ id: 11, kind: 'issue', text: 'AIが返事すると距離を感じる', author: 'aoi', createdAt: '2026-10-10T12:01:00.000Z' }] }],
}
const adminBoard: AdminOpinionBoard = {
  theme,
  topics: [
    {
      id: 1,
      title: '視聴者との距離',
      opinions: [
        {
          id: 11,
          kind: 'issue',
          text: 'AIが返事すると距離を感じる',
          author: 'aoi',
          createdAt: '2026-10-10T12:01:00.000Z',
          hidden: false,
          people: 2,
          sources: [
            { userName: 'aoi', text: 'AIのコメ返しはちょっと寂しい' },
            { userName: 'riku', text: 'AIの返事だと距離を感じる' },
          ],
        },
      ],
    },
  ],
}

/** 呼ばれた内容を記録し、決めた応答を返す fetch（本文が null なら本文の無い応答にする） */
const createFetchWithResponse = (status: number, body: unknown) => {
  const calls: { path: string; method: string; body: unknown }[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ path: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : null })
    return new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('createOpinionOverlayApi', () => {
  it('オーバーレイ用キー付きの経路から、意見ボードを読む', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(200, overlayBoard)

    expect(await createOpinionOverlayApi(fetchImpl, OVERLAY_KEY).read()).toEqual(overlayBoard)
    expect(calls.map((call) => call.path)).toEqual([`/api/overlay/opinions?key=${encodeURIComponent(OVERLAY_KEY)}`])
  })

  it('Workerが失敗を返したらエラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(401, { error: { code: 'invalid-overlay-key', message: 'オーバーレイ用キーが正しくありません' } })

    await expect(createOpinionOverlayApi(fetchImpl, OVERLAY_KEY).read()).rejects.toThrow(ApiError)
  })
})

describe('createOpinionApi', () => {
  it('人数ともとのコメントを添えた意見ボードを読む', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(200, adminBoard)

    expect(await createOpinionApi(fetchImpl).read()).toEqual(adminBoard)
    expect(calls.map((call) => call.path)).toEqual(['/api/admin/opinions'])
  })

  it('意見の人数ともとのコメントが欠けていればエラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(200, overlayBoard)

    await expect(createOpinionApi(fetchImpl).read()).rejects.toThrow()
  })

  it('テーマを開き、開いたテーマを返す', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(201, { theme })

    expect(await createOpinionApi(fetchImpl).openTheme('配信中にAIをどこまで使っていい？')).toEqual(theme)
    expect(calls).toEqual([{ path: '/api/admin/opinions/themes', method: 'POST', body: { title: '配信中にAIをどこまで使っていい？' } }])
  })

  it('テーマを締め切り、締め切ったテーマを返す', async () => {
    const closed = { ...theme, closedAt: '2026-10-10T12:30:00.000Z' }
    const { calls, fetchImpl } = createFetchWithResponse(200, { theme: closed })

    expect(await createOpinionApi(fetchImpl).closeTheme(1)).toEqual(closed)
    expect(calls).toEqual([{ path: '/api/admin/opinions/themes/1/close', method: 'POST', body: null }])
  })

  it('意見を隠す', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(204, null)

    await createOpinionApi(fetchImpl).setHidden(11, true)
    expect(calls).toEqual([{ path: '/api/admin/opinions/items/11', method: 'PUT', body: { hidden: true } }])
  })

  it('検証で拒まれたら、問題点を持つ ApiError にする', async () => {
    const { fetchImpl } = createFetchWithResponse(400, {
      error: { code: 'invalid-config', message: '意見ボードのテーマに問題があります', problems: ['テーマを入力してください'] },
    })

    await expect(createOpinionApi(fetchImpl).openTheme('')).rejects.toMatchObject({ problems: ['テーマを入力してください'] })
  })
})
