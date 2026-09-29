/**
 * 手書きで描いたものの読み書き（api.ts）のテスト
 *
 * 実際のWorkerへは通信せず、fetch を差し替えて「どんなリクエストを送るか」と「想定外の応答をエラーとして
 * 扱うか」を確かめる。特に重要なのは次の2点。
 * - 描く画面（セッション）と合成ページ（オーバーレイ用キー）で、同じ形の確かめを共有すること
 * - 応答が想定した形でなければエラーにすること（黙って「何も描かれていない」に倒すと、保存した図が
 *   出ない理由が分からなくなる）
 */
import { describe, expect, it } from 'vitest'
import { createDrawApi, createDrawOverlayApi } from './api'
import type { Stroke } from './strokes'

const サイト = 'https://hdad.example.com'
const オーバーレイ用キー = 'issued-overlay-key-0123456789abcdefghij'

/** 配信画面に引いた線1本 */
const 引いた線: Stroke = { id: '線1', points: [{ x: 0.1, y: 0.2 }], color: 'red', width: 'bold' }

/** 送られたリクエストを記録し、決めた応答を返す fetch */
const 応答を返すfetch = (status: number, body: unknown) => {
  const requests: Request[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(new URL(String(input), サイト), init))
    return Response.json(body, { status })
  }
  return { requests, fetchImpl }
}

describe('createDrawApi（描く画面からの読み書き）', () => {
  it('保存されている線を読む', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { strokes: [引いた線] })

    expect(await createDrawApi(fetchImpl).load()).toEqual({ strokes: [引いた線] })
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/draw/strokes')
  })

  it('一度も描いていない状態も読める', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { strokes: [] })

    expect(await createDrawApi(fetchImpl).load()).toEqual({ strokes: [] })
  })

  it('描いたものを保存する', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { strokes: [引いた線] })

    await createDrawApi(fetchImpl).save({ strokes: [引いた線] })

    expect(requests[0]!.method).toBe('PUT')
    expect(await requests[0]!.json()).toEqual({ strokes: [引いた線] })
  })

  it('保存の失敗はエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(400, { error: { code: 'invalid-config', message: '手書きで描いたものの指定に問題があります' } })

    await expect(createDrawApi(fetchImpl).save({ strokes: [引いた線] })).rejects.toThrow('手書きで描いたものの指定に問題があります')
  })

  it('線の配列を持たない応答はエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(200, {})

    await expect(createDrawApi(fetchImpl).load()).rejects.toThrow('/api/admin/draw/strokes')
  })

  it('選べない色の線を含む応答はエラーにする', async () => {
    // 既定の色に戻して描くと、配信画面に意図しない色の線が出たまま原因に気付けない
    const { fetchImpl } = 応答を返すfetch(200, { strokes: [{ ...引いた線, color: 'magenta' }] })

    await expect(createDrawApi(fetchImpl).load()).rejects.toThrow('/api/admin/draw/strokes')
  })
})

describe('createDrawOverlayApi（合成ページからの読み出し）', () => {
  it('オーバーレイ用キーを添えて、保存されている線を読む', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { strokes: [引いた線] })

    expect(await createDrawOverlayApi(fetchImpl, オーバーレイ用キー).read()).toEqual({ strokes: [引いた線] })
    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe('/api/overlay/draw/strokes')
    expect(url.searchParams.get('key')).toBe(オーバーレイ用キー)
  })

  it('想定した形でない応答はエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { strokes: '線1' })

    await expect(createDrawOverlayApi(fetchImpl, オーバーレイ用キー).read()).rejects.toThrow('/api/overlay/draw/strokes')
  })
})
