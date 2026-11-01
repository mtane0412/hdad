/**
 * 描画の画素比（src/core/render-ratio.ts）のテスト
 *
 * プレビューは縮小して映すので画素比に上限を設け、配信画面では上限を設けないことを確かめる。
 * 上限はページに1つの状態なので、テストごとにモジュールを読み直す。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let renderRatioModule: typeof import('./render-ratio')

beforeEach(async () => {
  vi.resetModules()
  renderRatioModule = await import('./render-ratio')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('renderRatio', () => {
  it('上限を決めていなければ（配信画面）、画面の画素比をそのまま返す', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 })

    expect(renderRatioModule.renderRatio()).toBe(2)
  })

  it('上限を決めたら（プレビュー）、画面の画素比が大きくても上限までにする', () => {
    vi.stubGlobal('window', { devicePixelRatio: 2 })

    renderRatioModule.limitRenderRatio(1)

    expect(renderRatioModule.renderRatio()).toBe(1)
  })

  it('画面の画素比が上限より小さければ、画面の画素比を返す（拡大して描かない）', () => {
    vi.stubGlobal('window', { devicePixelRatio: 0.75 })

    renderRatioModule.limitRenderRatio(1)

    expect(renderRatioModule.renderRatio()).toBe(0.75)
  })
})

describe('limitRenderRatio', () => {
  it('0以下の上限では描けないので投げる', () => {
    expect(() => renderRatioModule.limitRenderRatio(0)).toThrow('画素比の上限')
  })
})
