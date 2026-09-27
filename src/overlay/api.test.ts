/**
 * 合成オーバーレイの構成の読み出し（src/overlay/api.ts）のテスト
 *
 * fetch を差し替え、オーバーレイ用キーを付けて読むことと、想定した形でなければエラーにすることを確かめる。
 */
import { describe, expect, it, vi } from 'vitest'
import { createOverlayLayoutApi } from './api'

const キー = 'overlay-key-0123456789abcdefghij'

const 応答 = (body: unknown, status = 200): typeof fetch =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch

const 構成 = {
  layers: [
    { kind: 'clock', id: 'analog', params: 'size=200', group: 'front', rect: { x: 78, y: 70, width: 20, height: 26 } },
  ],
}

describe('createOverlayLayoutApi', () => {
  it('オーバーレイ用キーを付けて構成を読む', async () => {
    const fetchImpl = 応答(構成)

    const layers = await createOverlayLayoutApi(fetchImpl, キー).read()

    expect(layers).toEqual(構成.layers)
    expect(fetchImpl).toHaveBeenCalledWith(`/api/overlay/layout?key=${キー}`, undefined)
  })

  it('レイヤーが1件も無い構成も読める', async () => {
    expect(await createOverlayLayoutApi(応答({ layers: [] }), キー).read()).toEqual([])
  })

  it('想定した形でなければエラーにする（黙って空の構成にしない）', async () => {
    await expect(createOverlayLayoutApi(応答({ layers: [{ kind: 'clock' }] }), キー).read()).rejects.toThrow(/layers\[0\]/)
  })

  it('知らない種類が混ざっていたらエラーにする（ページが描けない種類を黙って飛ばさない）', async () => {
    const fetchImpl = 応答({ layers: [{ ...構成.layers[0], kind: 'timer' }] })

    await expect(createOverlayLayoutApi(fetchImpl, キー).read()).rejects.toThrow(/layers\[0\]/)
  })

  it('Workerが失敗を返したらエラーにする', async () => {
    const fetchImpl = 応答({ error: { code: 'invalid-overlay-key', message: 'キーが違います' } }, 401)

    await expect(createOverlayLayoutApi(fetchImpl, キー).read()).rejects.toThrow('キーが違います')
  })
})
