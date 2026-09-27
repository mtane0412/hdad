/**
 * 合成オーバーレイの構成の読み書き（src/overlay/admin-api.ts）のテスト
 *
 * fetch を差し替え、管理用API（/api/admin/overlay/layout）を読み書きすることと、
 * 想定した形でなければエラーにすることを確かめる（src/focus/api.ts・src/llm/api.ts と同じ扱い）。
 */
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../core/api'
import { createOverlayLayoutAdminApi } from './admin-api'
import type { OverlayLayer } from './layout'

const 応答 = (body: unknown, status = 200): typeof fetch =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch

const レイヤー: OverlayLayer = { kind: 'clock', id: 'analog', params: 'size=200', group: 'front', rect: { x: 78, y: 70, width: 20, height: 26 } }

describe('createOverlayLayoutAdminApi', () => {
  it('構成を読む', async () => {
    const fetchImpl = 応答({ layers: [レイヤー] })

    expect(await createOverlayLayoutAdminApi(fetchImpl).load()).toEqual([レイヤー])
    expect(fetchImpl).toHaveBeenCalledWith('/api/admin/overlay/layout', undefined)
  })

  it('レイヤーが1件も無い構成も読める（まだ何も置いていない状態）', async () => {
    expect(await createOverlayLayoutAdminApi(応答({ layers: [] })).load()).toEqual([])
  })

  it('構成を保存し、保存された構成を読み返す', async () => {
    const fetchImpl = 応答({ layers: [レイヤー] })

    expect(await createOverlayLayoutAdminApi(fetchImpl).save([レイヤー])).toEqual([レイヤー])
    expect(fetchImpl).toHaveBeenCalledWith('/api/admin/overlay/layout', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layers: [レイヤー] }),
    })
  })

  it('位置と大きさが数でなくても、そのまま送る（空欄を0に丸めず、検証はWorkerに任せる）', async () => {
    const fetchImpl = 応答({ layers: [] })
    const 空欄のレイヤー = { ...レイヤー, rect: { ...レイヤー.rect, width: Number.NaN } }

    await createOverlayLayoutAdminApi(fetchImpl).save([空欄のレイヤー])

    expect(fetchImpl).toHaveBeenCalledWith('/api/admin/overlay/layout', expect.objectContaining({ body: expect.stringContaining('"width":null') }))
  })

  it('想定した形でなければエラーにする（黙って空の構成にしない）', async () => {
    await expect(createOverlayLayoutAdminApi(応答({ layers: [{ kind: 'clock' }] })).load()).rejects.toThrow(/layers\[0\]/)
  })

  it('Workerが返した問題点は ApiError に載せて渡す（画面が1行ずつ並べる）', async () => {
    const fetchImpl = 応答(
      { error: { code: 'invalid-config', message: 'オーバーレイの構成に問題があります', problems: ['layers[0].rect.width: 1〜100 の数（％）で指定してください'] } },
      400,
    )

    await expect(createOverlayLayoutAdminApi(fetchImpl).save([レイヤー])).rejects.toMatchObject({
      problems: ['layers[0].rect.width: 1〜100 の数（％）で指定してください'],
    })
    await expect(createOverlayLayoutAdminApi(fetchImpl).save([レイヤー])).rejects.toBeInstanceOf(ApiError)
  })
})
