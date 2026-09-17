/**
 * 背景共通の補助関数（background.ts）のテスト
 */
import { describe, expect, it } from 'vitest'
import { createRandom, flowField, withAlpha } from './background'

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
