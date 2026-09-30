/**
 * 合成オーバーレイの構成の読み出し（src/overlay/api.ts）のテスト
 *
 * fetch を差し替え、オーバーレイ用キーを付けて読むことと、想定した形でなければエラーにすることを確かめる。
 */
import { describe, expect, it, vi } from 'vitest'
import { createOverlayLayoutApi } from './api'

const key = 'overlay-key-0123456789abcdefghij'

const response = (body: unknown, status = 200): typeof fetch =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch

const config = {
  overlays: [{ name: 'front', items: [{ kind: 'clock', id: 'analog', params: 'size=0.5', rect: { x: 78, y: 70, width: 20, height: 26 } }] }],
}

describe('createOverlayLayoutApi', () => {
  it('オーバーレイ用キーを付けて構成を読む', async () => {
    const fetchImpl = response(config)

    const overlays = await createOverlayLayoutApi(fetchImpl, key).read()

    expect(overlays).toEqual(config.overlays)
    expect(fetchImpl).toHaveBeenCalledWith(`/api/overlay/layout?key=${key}`, undefined)
  })

  it('オーバーレイが1つも無い構成も読める', async () => {
    expect(await createOverlayLayoutApi(response({ overlays: [] }), key).read()).toEqual([])
  })

  it('素材の形が想定と違えばエラーにする（黙って空の構成にしない）', async () => {
    const fetchImpl = response({ overlays: [{ name: 'front', items: [{ kind: 'clock' }] }] })

    await expect(createOverlayLayoutApi(fetchImpl, key).read()).rejects.toThrow(/overlays\[0\]/)
  })

  it('知らない種類が混ざっていたらエラーにする（ページが描けない種類を黙って飛ばさない）', async () => {
    const unknownKind = { overlays: [{ name: 'front', items: [{ ...config.overlays[0]?.items[0], kind: 'timer' }] }] }

    await expect(createOverlayLayoutApi(response(unknownKind), key).read()).rejects.toThrow(/overlays\[0\]/)
  })

  it('オーバーレイの形が想定と違えばエラーにする', async () => {
    await expect(createOverlayLayoutApi(response({ overlays: [{ name: 'front' }] }), key).read()).rejects.toThrow(/overlays\[0\]/)
  })

  it('Workerが失敗を返したらエラーにする', async () => {
    const fetchImpl = response({ error: { code: 'invalid-overlay-key', message: 'キーが違います' } }, 401)

    await expect(createOverlayLayoutApi(fetchImpl, key).read()).rejects.toThrow('キーが違います')
  })
})
