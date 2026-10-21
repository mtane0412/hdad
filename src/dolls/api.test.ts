/**
 * 人形の Worker の呼び出し（api.ts）のテスト
 *
 * 実際の通信はせず、fetch を差し替える。人形の組の読み書き・いまの人形の選択・視聴者への手での増減・ゲームの正解者に渡す人形の読み書きが、
 * 決まった経路と本文で呼ばれ、応答の形が違えば黙らずにエラーにすることを確かめる。
 */
import { describe, expect, it } from 'vitest'
import { createDollApi } from './api'
import type { DollHolding, DollSet } from './doll'

const bears: DollSet = {
  id: 1,
  normal: { name: 'クマ人形', mediaId: 'image-bear' },
  super: { name: 'スーパークマ人形', mediaId: 'image-super-bear' },
  current: true,
  updatedAt: '2026-10-21T12:00:00.000Z',
}

const hanakoHolding: DollHolding = { userId: '1001', setId: 1, normal: 2, super: 1 }

/** 呼ばれた内容を記録し、決めた応答を返す fetch（本文が null なら本文の無い応答にする） */
const createFetchWithResponse = (status: number, body: unknown) => {
  const calls: { path: string; method: string; body: unknown }[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ path: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : null })
    return new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('createDollApi', () => {
  it('人形の組と所持数を読む', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(200, { sets: [bears], holdings: [hanakoHolding] })

    expect(await createDollApi(fetchImpl).list()).toEqual({ sets: [bears], holdings: [hanakoHolding] })
    expect(calls.map((call) => call.path)).toEqual(['/api/admin/dolls'])
  })

  it('人形の組を追加・書き換え・削除する', async () => {
    const input = { normal: bears.normal, super: bears.super }

    const created = createFetchWithResponse(201, { set: bears })
    expect(await createDollApi(created.fetchImpl).create(input)).toEqual(bears)
    expect(created.calls).toEqual([{ path: '/api/admin/dolls', method: 'POST', body: input }])

    const updated = createFetchWithResponse(200, { set: bears })
    expect(await createDollApi(updated.fetchImpl).update(1, input)).toEqual(bears)
    expect(updated.calls).toEqual([{ path: '/api/admin/dolls/1', method: 'PUT', body: input }])

    const removed = createFetchWithResponse(204, null)
    await createDollApi(removed.fetchImpl).remove(1)
    expect(removed.calls).toEqual([{ path: '/api/admin/dolls/1', method: 'DELETE', body: null }])
  })

  it('いまの人形を選び、組の一覧を受け取る', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(200, { sets: [bears] })

    expect(await createDollApi(fetchImpl).selectCurrent(1)).toEqual([bears])
    expect(calls).toEqual([{ path: '/api/admin/doll-current', method: 'PUT', body: { setId: 1 } }])
  })

  it('視聴者にいまの人形を渡し、増減したあとの所持数を受け取る', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(200, { holding: hanakoHolding })

    expect(await createDollApi(fetchImpl).change('1001', 'super', 1)).toEqual(hanakoHolding)
    expect(calls).toEqual([{ path: '/api/admin/viewers/1001/dolls', method: 'POST', body: { kind: 'super', delta: 1 } }])
  })

  it('ゲームの正解者に渡す人形を読み書きする（渡さないのは null）', async () => {
    const read = createFetchWithResponse(200, { kind: null })
    expect(await createDollApi(read.fetchImpl).prize('chatDeduction')).toBeNull()
    expect(read.calls).toEqual([{ path: '/api/admin/doll-prizes/chatDeduction', method: 'GET', body: null }])

    const saved = createFetchWithResponse(200, { kind: 'super' })
    expect(await createDollApi(saved.fetchImpl).savePrize('kanjiQuiz', 'super')).toBe('super')
    expect(saved.calls).toEqual([{ path: '/api/admin/doll-prizes/kanjiQuiz', method: 'PUT', body: { kind: 'super' } }])
  })

  it('正解者に渡す人形の応答が知らない種類なら、渡さないことにせずエラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(200, { kind: 'golden' })

    await expect(createDollApi(fetchImpl).prize('kanjiQuiz')).rejects.toThrow()
  })

  it('応答の形が違えば、空の一覧にせずエラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(200, { sets: [{ id: 1, normal: { name: 'クマ人形' } }], holdings: [] })

    await expect(createDollApi(fetchImpl).list()).rejects.toThrow()
  })
})
