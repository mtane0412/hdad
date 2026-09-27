/**
 * 注目コメントのAPIの呼び出し（api.ts）のテスト
 *
 * 実際のWorkerへは通信せず、fetch を差し替えて「どんなリクエストを送るか」と
 * 「失敗や想定外の応答をエラーとして扱うか」を確認する。特に重要なのは次の2点。
 * - 管理画面（セッション）とオーバーレイ（オーバーレイ用キー）で、同じ形の確かめを共有すること
 * - 応答が想定した形でなければエラーにすること（黙って「取り上げていない」に倒すと、配信中に
 *   映らない理由が分からなくなる）
 */
import { describe, expect, it } from 'vitest'
import { createFocusApi, createFocusOverlayApi } from './api'
import type { FocusTarget } from './focused'

const サイト = 'https://hdad.example.com'
const オーバーレイ用キー = 'issued-overlay-key-0123456789abcdefghij'

const 追従の指定: FocusTarget = { type: 'viewer', login: 'kowai_hanashi' }

const 取り上げの指定: FocusTarget = {
  type: 'message',
  messageId: '発言1',
  login: 'kowai_hanashi',
  displayName: '怖い話す人',
  text: '今から怖い話をするね',
}

const 選べる発言 = {
  messageId: '発言1',
  login: 'kowai_hanashi',
  displayName: '怖い話す人',
  text: '今から怖い話をするね',
  at: '2026-09-27T12:10:00.000Z',
}

/** 送られたリクエストを記録し、決めた応答を返す fetch */
const 応答を返すfetch = (status: number, body: unknown) => {
  const requests: Request[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(new URL(String(input), サイト), init))
    return Response.json(body, { status })
  }
  return { requests, fetchImpl }
}

describe('createFocusApi（管理画面からの読み書き）', () => {
  it('取り上げているものを読む', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { target: 追従の指定 })

    expect(await createFocusApi(fetchImpl).load()).toEqual(追従の指定)
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/focus')
  })

  it('取り上げていない状態も読める', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { target: null })

    expect(await createFocusApi(fetchImpl).load()).toBeNull()
  })

  it('取り上げるものを保存する', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { target: 取り上げの指定 })

    expect(await createFocusApi(fetchImpl).save(取り上げの指定)).toEqual(取り上げの指定)
    const request = requests[0]!
    expect(request.method).toBe('PUT')
    expect(await request.json()).toEqual({ target: 取り上げの指定 })
  })

  it('取り上げているものを外すときは null を送る', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { target: null })

    await createFocusApi(fetchImpl).save(null)

    expect(await requests[0]!.json()).toEqual({ target: null })
  })

  it('取り上げる発言を選ぶための、直近の発言を読む', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { messages: [選べる発言] })

    expect(await createFocusApi(fetchImpl).recent()).toEqual([選べる発言])
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/focus/messages')
  })

  it('Workerが失敗を返したらエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(401, { error: { code: 'unauthorized', message: 'ログインしてください' } })

    await expect(createFocusApi(fetchImpl).load()).rejects.toThrow('ログインしてください')
  })

  it('応答に target が無ければエラーにする（黙って「取り上げていない」に倒さない）', async () => {
    const { fetchImpl } = 応答を返すfetch(200, {})

    await expect(createFocusApi(fetchImpl).load()).rejects.toThrow(/想定した形/)
  })

  it('取り上げ方の種類が分からない応答はエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { target: { type: 'stalker', login: 'kowai_hanashi' } })

    await expect(createFocusApi(fetchImpl).load()).rejects.toThrow(/想定した形/)
  })

  it('取り上げる発言の項目が欠けた応答はエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { target: { type: 'message', messageId: '発言1' } })

    await expect(createFocusApi(fetchImpl).load()).rejects.toThrow(/想定した形/)
  })

  it('直近の発言の項目が欠けた応答はエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { messages: [{ messageId: '発言1' }] })

    await expect(createFocusApi(fetchImpl).recent()).rejects.toThrow(/想定した形/)
  })
})

describe('createFocusOverlayApi（オーバーレイからの読み出し）', () => {
  it('オーバーレイ用キーをクエリに載せて読む', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { target: 追従の指定 })

    expect(await createFocusOverlayApi(fetchImpl, オーバーレイ用キー).read()).toEqual(追従の指定)
    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe('/api/overlay/focus')
    expect(url.searchParams.get('key')).toBe(オーバーレイ用キー)
  })

  it('キーが通らなければエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(401, { error: { code: 'invalid-overlay-key', message: 'オーバーレイ用キーが違います' } })

    await expect(createFocusOverlayApi(fetchImpl, 'ちがうキー').read()).rejects.toThrow('オーバーレイ用キーが違います')
  })
})
