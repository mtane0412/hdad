/**
 * タブの映像の切り出し範囲のテスト（issue #166）
 *
 * 範囲はタブの大きさに対する割合で持つ。次を確かめる。
 * - 届いた範囲を読み取り、タブの外にはみ出す・大きさが無いものはエラーにする
 * - 合成ページの箱の中で、切り出した範囲を縦横比を保ったまま収める（余白は透明）ための、枠と映像の置き方
 */
import { describe, expect, it } from 'vitest'
import { layoutCrop, parseTabCrop } from './crop'

describe('parseTabCrop', () => {
  it('タブの右下4分の1を読み取る', () => {
    expect(parseTabCrop({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 })).toEqual({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 })
  })

  it('割合の計算で端がわずかにはみ出しても受け入れる（ドラッグの位置を幅で割った誤差）', () => {
    expect(parseTabCrop({ x: 0.1, y: 0.2, width: 0.9000000000000001, height: 0.8 })).toEqual({ x: 0.1, y: 0.2, width: 0.9000000000000001, height: 0.8 })
  })

  it('タブの外にはみ出す範囲はエラーにする', () => {
    expect(() => parseTabCrop({ x: 0.6, y: 0, width: 0.5, height: 1 })).toThrow('映す範囲の形が想定と違います')
    expect(() => parseTabCrop({ x: -0.1, y: 0, width: 0.5, height: 1 })).toThrow('映す範囲の形が想定と違います')
  })

  it('幅や高さが無い範囲はエラーにする', () => {
    expect(() => parseTabCrop({ x: 0.2, y: 0.2, width: 0, height: 0.5 })).toThrow('映す範囲の形が想定と違います')
  })

  it('数でないものが入っていればエラーにする', () => {
    expect(() => parseTabCrop({ x: '左端', y: 0, width: 1, height: 1 })).toThrow('映す範囲の形が想定と違います')
    expect(() => parseTabCrop(null)).toThrow('映す範囲の形が想定と違います')
  })
})

describe('layoutCrop', () => {
  /** 1920×1080 の箱 */
  const box = { width: 1920, height: 1080 }
  /** タブの映像（1600×900） */
  const video = { width: 1600, height: 900 }

  it('範囲が無ければ、タブ全体を箱に収める（縦横比が同じなら箱いっぱい）', () => {
    expect(layoutCrop(box, video, null)).toEqual({
      clip: { left: 0, top: 0, width: 1920, height: 1080 },
      video: { left: 0, top: 0, width: 1920, height: 1080 },
    })
  })

  it('横長の範囲は、箱の幅に合わせて上下の余白を残す', () => {
    // タブの上半分（1600×450）を 1920 の幅に合わせると 1.2 倍で 1920×540。上下に 270 ずつ余白ができる
    expect(layoutCrop(box, video, { x: 0, y: 0, width: 1, height: 0.5 })).toEqual({
      clip: { left: 0, top: 270, width: 1920, height: 540 },
      video: { left: 0, top: 0, width: 1920, height: 1080 },
    })
  })

  it('右下4分の1を切り出すと、映像を2倍にして左上へずらす', () => {
    // 右下4分の1（800×450）は箱と同じ縦横比なので、2.4 倍で箱いっぱい。映像全体は 3840×2160 になり、左上へ 1920×1080 ずらす
    expect(layoutCrop(box, video, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 })).toEqual({
      clip: { left: 0, top: 0, width: 1920, height: 1080 },
      video: { left: -1920, top: -1080, width: 3840, height: 2160 },
    })
  })

  it('縦長の範囲は、箱の高さに合わせて左右の余白を残す', () => {
    // 左端の幅 9/32（450×900）を 1080 の高さに合わせると 1.2 倍で 540×1080。左右に 690 ずつ余白ができる
    expect(layoutCrop(box, video, { x: 0, y: 0, width: 9 / 32, height: 1 })).toEqual({
      clip: { left: 690, top: 0, width: 540, height: 1080 },
      video: { left: 0, top: 0, width: 1920, height: 1080 },
    })
  })

  it('映像か箱の大きさがまだ分からなければ、置き方を決めない', () => {
    expect(layoutCrop(box, { width: 0, height: 0 }, null)).toBeNull()
    expect(layoutCrop({ width: 0, height: 0 }, video, null)).toBeNull()
  })
})
