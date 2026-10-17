/**
 * 演出を消す合図（src/overlay/dismiss.ts）のテスト
 *
 * - 下部バーが POST /api/admin/overlay/dismiss を呼ぶこと。断られたら理由を投げること
 * - 合成ページが受け取った合図を読めること。想定した形でなければ投げること（Fail-Fast）
 */
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../core/api'
import { createOverlayDismissApi, parseOverlayDismiss } from './dismiss'

describe('createOverlayDismissApi', () => {
  it('演出を消すよう Worker に頼む', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch

    await createOverlayDismissApi(fetchImpl).dismiss()

    expect(fetchImpl).toHaveBeenCalledWith('/api/admin/overlay/dismiss', { method: 'POST' })
  })

  it('合成ページへ送れなかったら、Worker の理由を添えて投げる', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'overlay-dismiss-push-failed', message: '合成ページへ演出を消す合図を送れませんでした' } }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as unknown as typeof fetch

    await expect(createOverlayDismissApi(fetchImpl).dismiss()).rejects.toThrow(ApiError)
  })
})

describe('parseOverlayDismiss', () => {
  it('演出を消す合図を読める', () => {
    expect(() => parseOverlayDismiss('{"type":"dismiss"}')).not.toThrow()
  })

  it('合図でないものは投げる（Worker の作りが変わったことに気づけるようにする）', () => {
    expect(() => parseOverlayDismiss('{"type":"alert"}')).toThrow('演出を消す合図')
    expect(() => parseOverlayDismiss('消して')).toThrow()
  })
})
