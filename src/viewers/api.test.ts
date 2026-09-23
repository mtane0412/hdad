/**
 * 視聴者の記録のAPIの呼び出し（api.ts）のテスト
 *
 * 実際のWorkerへは通信せず、fetch を差し替えて「どんなリクエストを送るか」と
 * 「失敗や想定外の応答をエラーとして扱うか」を確認する。
 */
import { describe, expect, it } from 'vitest'
import { createViewerApi } from './api'

const サイト = 'https://hdad.example.com'

const 花子 = {
  userId: '100',
  login: 'hanako',
  displayName: '花子',
  firstSeenAt: '2026-09-01T12:00:00.000Z',
  lastSeenAt: '2026-09-21T12:00:00.000Z',
  messageCount: 42,
  badges: ['subscriber'],
  note: 'ゲームの話をよくする人',
  summary: 'ギターの話をよくする常連さん',
  summarizedAt: '2026-09-21T13:00:00.000Z',
}

/** 送られたリクエストを記録し、決めた応答を返す fetch。body が null なら本文のない応答にする */
const 応答を返すfetch = (status: number, body: unknown) => {
  const requests: Request[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(new URL(String(input), サイト), init))
    return body === null ? new Response(null, { status }) : Response.json(body, { status })
  }
  return { requests, fetchImpl }
}

describe('list（視聴者の一覧）', () => {
  it('記録のある人の一覧を取得する', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { viewers: [花子] })

    expect(await createViewerApi(fetchImpl).list({})).toEqual([花子])
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/viewers')
  })

  it('検索の語と続きの目印をクエリに載せる', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { viewers: [] })

    await createViewerApi(fetchImpl).list({ search: 'hana', before: '2026-09-21T12:00:00.000Z', beforeUserId: '100' })

    const url = new URL(requests[0]!.url)
    expect(url.searchParams.get('search')).toBe('hana')
    expect(url.searchParams.get('before')).toBe('2026-09-21T12:00:00.000Z')
    expect(url.searchParams.get('beforeUserId')).toBe('100')
  })

  it('一度に取る件数をクエリに載せる', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { viewers: [] })

    await createViewerApi(fetchImpl).list({ limit: 50 })

    expect(new URL(requests[0]!.url).searchParams.get('limit')).toBe('50')
  })

  it('検索の語が空なら、クエリに載せない', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { viewers: [] })

    await createViewerApi(fetchImpl).list({ search: '' })

    expect(new URL(requests[0]!.url).search).toBe('')
  })

  it('応答が想定した形でなければエラーにする（黙って空の一覧にしない）', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { viewers: [{ ...花子, messageCount: '42' }] })

    await expect(createViewerApi(fetchImpl).list({})).rejects.toThrow()
  })

  it('Workerが失敗を返したら、その理由を持つエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(400, { error: { code: 'invalid-limit', message: 'limit は1〜200の整数にしてください' } })

    await expect(createViewerApi(fetchImpl).list({})).rejects.toThrow('limit は1〜200の整数にしてください')
  })
})

describe('saveNote（メモの保存）', () => {
  it('メモをPATCHで送り、保存された内容を返す', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { userId: '100', note: '常連さん' })

    expect(await createViewerApi(fetchImpl).saveNote('100', '常連さん')).toBe('常連さん')
    expect(requests[0]!.method).toBe('PATCH')
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/viewers/100')
    expect(await requests[0]!.json()).toEqual({ note: '常連さん' })
  })

  it('応答に note が無ければエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { userId: '100' })

    await expect(createViewerApi(fetchImpl).saveNote('100', '常連さん')).rejects.toThrow()
  })
})

describe('remove（記録の削除）', () => {
  it('DELETEで記録を消す', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(204, null)

    await createViewerApi(fetchImpl).remove('100')

    expect(requests[0]!.method).toBe('DELETE')
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/viewers/100')
  })
})

describe('人物像の受け取り', () => {
  it('人物像をまだ作っていない人（summary が空・summarizedAt が null）も受け取れる', async () => {
    const 新顔 = { ...花子, summary: '', summarizedAt: null }
    const { fetchImpl } = 応答を返すfetch(200, { viewers: [新顔] })

    expect(await createViewerApi(fetchImpl).list({})).toEqual([新顔])
  })

  it('人物像の形が違えば、黙って受け取らずエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { viewers: [{ ...花子, summary: 123 }] })

    await expect(createViewerApi(fetchImpl).list({})).rejects.toThrow()
  })
})
