/**
 * sparkles（またたくきらきら）の明滅と配置の計算に対するテスト
 *
 * cycle は「経過時間 × またたく頻度 + きらきらごとのずれ」で、1進むごとに
 * 「現れる → 最大まで大きくなる → 消える」を1回行う。消えている瞬間に次の位置へ移る。
 */
import { describe, expect, it } from 'vitest'
import { sparklePlacement, twinkle } from './sparkles'

describe('twinkle（きらきらの大きさの比率、0〜1）', () => {
  it('cycle が整数のとき0になる（完全に消えているので、位置が変わっても見えない）', () => {
    expect(twinkle(0)).toBe(0)
    expect(twinkle(4)).toBeCloseTo(0)
  })

  it('cycle の中間で最大の1になる', () => {
    expect(twinkle(2.5)).toBeCloseTo(1)
  })

  it('どの cycle でも0〜1に収まる', () => {
    for (let cycle = 0; cycle < 6; cycle += 0.017) {
      const size = twinkle(cycle)
      expect(size).toBeGreaterThanOrEqual(0)
      expect(size).toBeLessThanOrEqual(1)
    }
  })
})

describe('sparklePlacement（きらきらの位置と大きさ）', () => {
  it('同じ番号・同じ世代なら、いつ計算しても同じ配置になる', () => {
    expect(sparklePlacement(3, 7)).toEqual(sparklePlacement(3, 7))
  })

  it('世代（何回目のまたたきか）が変わると、別の位置に現れる', () => {
    expect(sparklePlacement(3, 7).x).not.toBe(sparklePlacement(3, 8).x)
  })

  it('位置と大きさの比率は0以上1未満に収まる', () => {
    for (let index = 0; index < 30; index++) {
      for (let generation = 0; generation < 10; generation++) {
        const { x, y, scale } = sparklePlacement(index, generation)
        for (const value of [x, y, scale]) {
          expect(value).toBeGreaterThanOrEqual(0)
          expect(value).toBeLessThan(1)
        }
      }
    }
  })
})
