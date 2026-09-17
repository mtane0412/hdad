/**
 * stripes（斜めストライプ）の帯のずれ量の計算に対するテスト
 */
import { describe, expect, it } from 'vitest'
import { stripeShift } from './stripes'

describe('stripeShift（帯のずれ量）', () => {
  it('表示開始時点（0秒）ではずれがない', () => {
    expect(stripeShift(0, 1, 80)).toBe(0)
  })

  it('どの時刻でも、ずれは0以上かつ帯の周期（size）未満に収まる', () => {
    // 前提: 帯の周期は80px。0〜200秒を0.7秒刻みで調べる
    const size = 80
    for (let time = 0; time < 200; time += 0.7) {
      const shift = stripeShift(time, 1, size)
      expect(shift).toBeGreaterThanOrEqual(0)
      expect(shift).toBeLessThan(size)
    }
  })

  it('時間が進むと、ずれが増える（帯が流れる）', () => {
    expect(stripeShift(1, 1, 80)).toBeGreaterThan(stripeShift(0.5, 1, 80))
  })

  it('speed が0なら、時間が進んでも静止したままになる', () => {
    expect(stripeShift(123, 0, 80)).toBe(0)
  })
})
