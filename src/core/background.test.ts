/**
 * 背景共通の補助関数（background.ts）のテスト
 */
import { describe, expect, it } from 'vitest'
import { createRandom, flowField, loopPosition, pickColor, withAlpha } from './background'

describe('withAlpha', () => {
  it('不透明度を16進数2桁にして色の末尾へ付ける', () => {
    expect(withAlpha('#ff0080', 1)).toBe('#ff0080ff')
    expect(withAlpha('#ff0080', 0)).toBe('#ff008000')
    expect(withAlpha('#ff0080', 0.5)).toBe('#ff008080')
  })

  it('0〜1の範囲を超えた不透明度は、色として不正な文字列にならないよう端の値になる', () => {
    expect(withAlpha('#ff0080', 1.5)).toBe('#ff0080ff')
    expect(withAlpha('#ff0080', -0.2)).toBe('#ff008000')
  })
})

describe('createRandom', () => {
  it('同じ種からは同じ乱数列が得られる（再読み込みしても配置が変わらない）', () => {
    const 一回目 = createRandom(412)
    const 二回目 = createRandom(412)
    expect([一回目(), 一回目(), 一回目()]).toEqual([二回目(), 二回目(), 二回目()])
  })

  it('種が違えば乱数列も変わる', () => {
    expect(createRandom(1)()).not.toBe(createRandom(2)())
  })

  it('値は0以上1未満に収まる', () => {
    const random = createRandom(7)
    for (let i = 0; i < 1000; i++) {
      const value = random()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})

describe('flowField', () => {
  it('どの位置・時刻でも -1〜1 に収まる', () => {
    for (let step = 0; step < 500; step++) {
      const value = flowField(step * 0.37, step * 0.11, step * 1.9)
      expect(Math.abs(value)).toBeLessThanOrEqual(1)
    }
  })

  it('時間が進むと同じ位置の値が変わる（模様が動く）', () => {
    expect(flowField(1, 1, 0)).not.toBe(flowField(1, 1, 10))
  })
})

describe('loopPosition（画面の外へ抜けたら反対側から戻る循環位置）', () => {
  it('進み具合0のとき、画面の手前の余白の端（-余白）にいる', () => {
    // 前提: 画面の長さ1000px、余白50px
    expect(loopPosition(0, 1000, 50)).toBe(-50)
  })

  it('進み具合0.5のとき、画面の中央にいる', () => {
    expect(loopPosition(0.5, 1000, 50)).toBe(500)
  })

  it('進み具合が1を超えても、-余白 以上 長さ+余白 未満の範囲を循環する', () => {
    expect(loopPosition(3.5, 1000, 50)).toBeCloseTo(500)
    for (let progress = 0; progress < 5; progress += 0.013) {
      const position = loopPosition(progress, 1000, 50)
      expect(position).toBeGreaterThanOrEqual(-50)
      expect(position).toBeLessThan(1050)
    }
  })

  it('進み具合が負（逆向きに進む）でも同じ範囲を循環する', () => {
    expect(loopPosition(-0.5, 1000, 50)).toBeCloseTo(500)
    expect(loopPosition(-2.25, 1000, 50)).toBeCloseTo(loopPosition(0.75, 1000, 50))
  })
})

describe('pickColor（配色から番号に応じた色を選ぶ）', () => {
  const パステル配色 = ['#ffafcc', '#a2d2ff', '#b9fbc0']

  it('番号が配色の数を超えたら、先頭の色へ戻って繰り返す', () => {
    expect(pickColor(パステル配色, 0)).toBe('#ffafcc')
    expect(pickColor(パステル配色, 2)).toBe('#b9fbc0')
    expect(pickColor(パステル配色, 3)).toBe('#ffafcc')
    expect(pickColor(パステル配色, 7)).toBe('#a2d2ff')
  })

  it('配色が空の場合は、色なしで描画を続けずにエラーにする', () => {
    expect(() => pickColor([], 0)).toThrow('配色が空')
  })
})
