/**
 * 手書きの道具（色と太さ）のテスト
 *
 * 選べる色と太さは、描く画面と合成ページの両方が読む1か所である（2か所に持つと、片方だけ増やしたときに
 * 検証が食い違う）。ここで確かめるのは、一覧が識別子として使える形になっていることと、
 * 既定が一覧に含まれていることである。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_COLOR_ID, DEFAULT_WIDTH_ID, DRAW_COLORS, DRAW_WIDTHS, colorOf, isColorId, isWidthId, widthOf } from './tools'

describe('DRAW_COLORS', () => {
  it('同じ名前の色を二重に持たない', () => {
    expect(new Set(DRAW_COLORS.map(({ id }) => id)).size).toBe(DRAW_COLORS.length)
  })

  it('どの色にも、画面に出す日本語の名前がある', () => {
    for (const color of DRAW_COLORS) expect(color.label).not.toBe('')
  })

  it('既定の色は一覧にある', () => {
    expect(isColorId(DEFAULT_COLOR_ID)).toBe(true)
  })
})

describe('DRAW_WIDTHS', () => {
  it('同じ名前の太さを二重に持たない', () => {
    expect(new Set(DRAW_WIDTHS.map(({ id }) => id)).size).toBe(DRAW_WIDTHS.length)
  })

  it('細い順に並んでいる（画面の並びがそのまま太さの順になる）', () => {
    const ratios = DRAW_WIDTHS.map(({ ratio }) => ratio)
    expect(ratios).toEqual([...ratios].sort((a, b) => a - b))
  })

  it('既定の太さは一覧にある', () => {
    expect(isWidthId(DEFAULT_WIDTH_ID)).toBe(true)
  })
})

describe('isColorId・isWidthId', () => {
  it('一覧にないものは受け付けない', () => {
    expect(isColorId('虹色')).toBe(false)
    expect(isWidthId('極太')).toBe(false)
  })
})

describe('colorOf・widthOf', () => {
  it('名前から、描くのに使う値を引く', () => {
    expect(colorOf(DEFAULT_COLOR_ID).value).toMatch(/^#[0-9a-f]{6}$/)
    expect(widthOf(DEFAULT_WIDTH_ID).ratio).toBeGreaterThan(0)
  })

  it('一覧にない名前は、黙って既定に戻さずエラーにする', () => {
    // 検証を通っていない値がここへ来るのは、送り手か検証の作りが壊れている印である
    expect(() => colorOf('虹色')).toThrow('手書きの色「虹色」は選べません')
    expect(() => widthOf('極太')).toThrow('手書きの太さ「極太」は選べません')
  })
})
