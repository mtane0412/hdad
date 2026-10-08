/**
 * テキストの Worker の呼び出し（api.ts）のテスト
 *
 * 実際の通信はせず、fetch を差し替える。合成ページの読み出し（オーバーレイ用キー）と、
 * アプリのページ（/texts/）・下部バーの読み書きの両方を確かめる。
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../core/api'
import { createTextApi, createTextOverlayApi } from './api'
import type { TextEntry } from './entry'

const OVERLAY_KEY = 'overlay-key_0123456789abcdefghij'
const goal: TextEntry = { id: 1, name: '目標', body: 'ログイン画面を作り終える', mode: 'manual', instruction: '', writtenBy: 'human', updatedAt: '2026-10-08T12:00:00.000Z' }

/** 呼ばれた内容を記録し、決めた応答を返す fetch（本文が null なら本文の無い応答にする） */
const createFetchWithResponse = (status: number, body: unknown) => {
  const calls: { path: string; method: string; body: unknown }[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ path: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : null })
    return new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('createTextOverlayApi', () => {
  it('オーバーレイ用キー付きの経路から、テキストの一覧を読む', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(200, { texts: [goal] })

    expect(await createTextOverlayApi(fetchImpl, OVERLAY_KEY).read()).toEqual([goal])
    expect(calls.map((call) => call.path)).toEqual([`/api/overlay/texts?key=${encodeURIComponent(OVERLAY_KEY)}`])
  })

  it('Workerが失敗を返したらエラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(401, { error: { code: 'invalid-overlay-key', message: 'オーバーレイ用キーが正しくありません' } })

    await expect(createTextOverlayApi(fetchImpl, OVERLAY_KEY).read()).rejects.toThrow(ApiError)
  })
})

describe('createTextApi', () => {
  it('テキストの一覧を読む', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(200, { texts: [goal] })

    expect(await createTextApi(fetchImpl).list()).toEqual([goal])
    expect(calls.map((call) => call.path)).toEqual(['/api/admin/texts'])
  })

  it('テキストを追加し、追加したテキストを返す', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(201, { text: goal })

    expect(await createTextApi(fetchImpl).create({ name: '目標', mode: 'manual', body: 'ログイン画面を作り終える', instruction: '' })).toEqual(goal)
    expect(calls).toEqual([{ path: '/api/admin/texts', method: 'POST', body: { name: '目標', mode: 'manual', body: 'ログイン画面を作り終える', instruction: '' } }])
  })

  it('テキストを書き換え、書き換えたテキストを返す', async () => {
    const updated = { ...goal, body: 'ログイン画面をデプロイする' }
    const { calls, fetchImpl } = createFetchWithResponse(200, { text: updated })

    expect(await createTextApi(fetchImpl).update(1, { name: '目標', mode: 'manual', body: 'ログイン画面をデプロイする', instruction: '' })).toEqual(updated)
    expect(calls).toEqual([{ path: '/api/admin/texts/1', method: 'PUT', body: { name: '目標', mode: 'manual', body: 'ログイン画面をデプロイする', instruction: '' } }])
  })

  it('テキストを消す', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(204, null)

    await createTextApi(fetchImpl).remove(1)
    expect(calls).toEqual([{ path: '/api/admin/texts/1', method: 'DELETE', body: null }])
  })

  it('応答の text の形が違えばエラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(201, { text: { id: 1 } })

    await expect(createTextApi(fetchImpl).create({ name: '目標', mode: 'manual', body: '', instruction: '' })).rejects.toThrow('テキスト')
  })

  it('検証で拒まれたら、問題点を持つ ApiError にする', async () => {
    const { fetchImpl } = createFetchWithResponse(400, {
      error: { code: 'invalid-config', message: 'テキストに問題があります', problems: ['name: 「目標」という名前のテキストはもうあります'] },
    })

    await expect(createTextApi(fetchImpl).create({ name: '目標', mode: 'manual', body: '', instruction: '' })).rejects.toMatchObject({ problems: ['name: 「目標」という名前のテキストはもうあります'] })
  })
})
