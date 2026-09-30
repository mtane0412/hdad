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

const site = 'https://hdad.example.com'
const overlayKey = 'issued-overlay-key-0123456789abcdefghij'

/** 配信画面に引いた線1本 */
const drawnStroke: Stroke = { id: '線1', points: [{ x: 0.1, y: 0.2 }], color: 'red', width: 'bold' }

/** 送られたリクエストを記録し、決めた応答を返す fetch */
const fetchReturning = (status: number, body: unknown) => {
  const requests: Request[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(new URL(String(input), site), init))
    return Response.json(body, { status })
  }
  return { requests, fetchImpl }
}

describe('createDrawApi（描く画面からの読み書き）', () => {
  it('保存されている線を読む', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { strokes: [drawnStroke] })

    expect(await createDrawApi(fetchImpl).load()).toEqual({ strokes: [drawnStroke] })
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/draw/strokes')
  })

  it('一度も描いていない状態も読める', async () => {
    const { fetchImpl } = fetchReturning(200, { strokes: [] })

    expect(await createDrawApi(fetchImpl).load()).toEqual({ strokes: [] })
  })

  it('描いたものを保存する', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { strokes: [drawnStroke] })

    await createDrawApi(fetchImpl).save({ strokes: [drawnStroke] })

    expect(requests[0]!.method).toBe('PUT')
    expect(await requests[0]!.json()).toEqual({ strokes: [drawnStroke] })
  })

  it('保存の失敗はエラーにする', async () => {
    const { fetchImpl } = fetchReturning(400, { error: { code: 'invalid-config', message: '手書きで描いたものの指定に問題があります' } })

    await expect(createDrawApi(fetchImpl).save({ strokes: [drawnStroke] })).rejects.toThrow('手書きで描いたものの指定に問題があります')
  })

  it('線の配列を持たない応答はエラーにする', async () => {
    const { fetchImpl } = fetchReturning(200, {})

    await expect(createDrawApi(fetchImpl).load()).rejects.toThrow('/api/admin/draw/strokes')
  })

  it('選べない色の線を含む応答はエラーにする', async () => {
    // 既定の色に戻して描くと、配信画面に意図しない色の線が出たまま原因に気付けない
    const { fetchImpl } = fetchReturning(200, { strokes: [{ ...drawnStroke, color: 'magenta' }] })

    await expect(createDrawApi(fetchImpl).load()).rejects.toThrow('/api/admin/draw/strokes')
  })
})

describe('createDrawApi の loadBackground（描く画面の背景）', () => {
  const capturedAt = Date.parse('2026-09-29T12:00:00Z')
  const imageId = 'abcdef0123456789abcdef0123456789'
  const imageUrl = `https://i.gyazo.com/${imageId}.png`

  /** 送られたリクエストを記録し、決めた応答をそのまま返す fetch */
  const fetchReturningBackground = (response: () => Response) => {
    const requests: Request[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push(new Request(new URL(String(input), site), init))
      return response()
    }
    return { requests, fetchImpl }
  }

  const imageResponse = () => Response.json({ imageId, capturedAt, url: imageUrl }, { headers: { ETag: `"${imageId}"` } })

  it('最後に撮った配信画面のURLを、撮った時刻と印付きで読む', async () => {
    const { requests, fetchImpl } = fetchReturningBackground(imageResponse)

    const result = await createDrawApi(fetchImpl).loadBackground(null)

    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/draw/background')
    expect(requests[0]!.headers.has('If-None-Match')).toBe(false)
    expect(result).toEqual({ kind: 'image', url: imageUrl, etag: `"${imageId}"`, capturedAt })
  })

  it('手元の1枚の印を添えて読み、変わっていなければそう伝える', async () => {
    const { requests, fetchImpl } = fetchReturningBackground(() => new Response(null, { status: 304 }))

    expect(await createDrawApi(fetchImpl).loadBackground(`"${imageId}"`)).toEqual({ kind: 'unchanged' })
    expect(requests[0]!.headers.get('If-None-Match')).toBe(`"${imageId}"`)
  })

  it('まだ1枚も無ければ、そう伝える', async () => {
    const { fetchImpl } = fetchReturningBackground(() => new Response(null, { status: 204 }))

    expect(await createDrawApi(fetchImpl).loadBackground(null)).toEqual({ kind: 'none' })
  })

  it('想定した形でない応答はエラーにする', async () => {
    const { fetchImpl } = fetchReturningBackground(() => Response.json({ imageId, capturedAt }, { headers: { ETag: `"${imageId}"` } }))

    await expect(createDrawApi(fetchImpl).loadBackground(null)).rejects.toThrow('/api/admin/draw/background')
  })

  it('Gyazo 以外のURLはエラーにする（知らない場所の画像を背景に読み込まない）', async () => {
    const { fetchImpl } = fetchReturningBackground(() =>
      Response.json({ imageId, capturedAt, url: 'https://example.com/画面.png' }, { headers: { ETag: `"${imageId}"` } }),
    )

    await expect(createDrawApi(fetchImpl).loadBackground(null)).rejects.toThrow('/api/admin/draw/background')
  })

  it('失敗の応答はエラーにする', async () => {
    const { fetchImpl } = fetchReturningBackground(() => Response.json({ error: { code: 'unauthorized', message: 'ログインしてください' } }, { status: 401 }))

    await expect(createDrawApi(fetchImpl).loadBackground(null)).rejects.toThrow('ログインしてください')
  })
})

describe('createDrawOverlayApi（合成ページからの読み出し）', () => {
  it('オーバーレイ用キーを添えて、保存されている線を読む', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { strokes: [drawnStroke] })

    expect(await createDrawOverlayApi(fetchImpl, overlayKey).read()).toEqual({ strokes: [drawnStroke] })
    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe('/api/overlay/draw/strokes')
    expect(url.searchParams.get('key')).toBe(overlayKey)
  })

  it('想定した形でない応答はエラーにする', async () => {
    const { fetchImpl } = fetchReturning(200, { strokes: '線1' })

    await expect(createDrawOverlayApi(fetchImpl, overlayKey).read()).rejects.toThrow('/api/overlay/draw/strokes')
  })
})
