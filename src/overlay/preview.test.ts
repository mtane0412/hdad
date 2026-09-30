/**
 * プレビューの受け渡し（src/overlay/preview.ts）のテスト
 *
 * 管理画面（overlay-page.tsx）と、プレビューとして開いた合成ページ（src/overlay/stage.ts）のあいだで
 * やり取りする知らせを確かめる。通信もDOMも持ち込まない部分なので、ここだけを取り出してテストできる。
 *
 * 確かめたいのは次の3点である。
 * - 編集中の構成を渡して、そのまま読み戻せること（保存しなくてもプレビューに映るための道である）
 * - 自分たちの知らせでないものは読まずに undefined を返すこと（同じ窓には他の知らせも届く）
 * - 自分たちの知らせなのに形が違えばエラーにすること（黙って空の構成にしない。Fail-Fast）
 */
import { describe, expect, it, vi } from 'vitest'
import type { Overlay } from './layout'
import { previewLayoutMessage, previewReadyMessage, readPreviewLayout, replyPreviewLayout } from './preview'

const front: Overlay = {
  name: 'front',
  items: [
    { kind: 'clock', id: 'analog', params: 'size=0.5', rect: { x: 78, y: 70, width: 20, height: 26 } },
    { kind: 'sideSuper', id: '', params: '', rect: { x: 2, y: 80, width: 40, height: 16 } },
  ],
}

describe('previewLayoutMessage と readPreviewLayout', () => {
  it('編集中の構成を渡し、そのまま読み戻せる', () => {
    expect(readPreviewLayout(previewLayoutMessage([front]))).toEqual([front])
  })

  it('自分たちの知らせでなければ undefined を返す（同じ窓に届く他の知らせを読まない）', () => {
    expect(readPreviewLayout(previewReadyMessage())).toBeUndefined()
    expect(readPreviewLayout({ type: 'webpack-hot-update' })).toBeUndefined()
    expect(readPreviewLayout('hello')).toBeUndefined()
    expect(readPreviewLayout(null)).toBeUndefined()
  })

  it('自分たちの知らせなのに素材の形が違えばエラーにする（黙って空の構成にしない）', () => {
    expect(() => readPreviewLayout({ ...previewLayoutMessage([]), overlays: [{ name: 'front', items: [{ kind: 'clock' }] }] })).toThrow(
      /overlays\[0\]/,
    )
  })

  it('自分たちの知らせなのに構成の配列が無ければエラーにする', () => {
    expect(() => readPreviewLayout({ ...previewLayoutMessage([]), overlays: undefined })).toThrow(/overlays/)
  })
})

describe('replyPreviewLayout', () => {
  const site = 'https://hdad.example.com'

  /** プレビューの窓の代役（送る口だけを持つ） */
  const win = () => ({ postMessage: vi.fn() })

  it('構成を待っているプレビューへ、いまの編集中の構成を渡す', () => {
    const previewWindow = win()

    const passed = replyPreviewLayout({ data: previewReadyMessage(), origin: site, source: previewWindow }, site, [front])

    expect(passed).toBe(true)
    expect(previewWindow.postMessage).toHaveBeenCalledWith(previewLayoutMessage([front]), site)
  })

  it('よそのサイトからの知らせには渡さない', () => {
    const foreignWindow = win()

    const passed = replyPreviewLayout({ data: previewReadyMessage(), origin: 'https://evil.example.com', source: foreignWindow }, site, [front])

    expect(passed).toBe(false)
    expect(foreignWindow.postMessage).not.toHaveBeenCalled()
  })

  it('自分たちの知らせでなければ何もしない（同じ窓に届く他の知らせに応えない）', () => {
    const fakeWindow = win()

    expect(replyPreviewLayout({ data: { type: 'vite:beforeUpdate' }, origin: site, source: fakeWindow }, site, [front])).toBe(false)
    expect(fakeWindow.postMessage).not.toHaveBeenCalled()
  })

  it('送る口を持たない相手には渡さない', () => {
    expect(replyPreviewLayout({ data: previewReadyMessage(), origin: site, source: null }, site, [front])).toBe(false)
    expect(replyPreviewLayout({ data: previewReadyMessage(), origin: site, source: {} }, site, [front])).toBe(false)
  })
})
