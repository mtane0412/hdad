/**
 * polka（ぷにぷに伸び縮みする水玉）の大きさの計算に対するテスト
 */
import { describe, expect, it } from 'vitest'
import { DOT_MIN_SCALE, dotScale } from './polka'

describe('dotScale（水玉の大きさの比率）', () => {
  it('どの位置・時刻でも、最小の比率以上1以下に収まる（水玉が消えたり隣と重なったりしない）', () => {
    for (let step = 0; step < 500; step++) {
      const scale = dotScale(step * 0.41, step * 0.29, step * 1.7)
      expect(scale).toBeGreaterThanOrEqual(DOT_MIN_SCALE)
      expect(scale).toBeLessThanOrEqual(1)
    }
  })

  it('時間が進むと大きさが変わる（伸び縮みする）', () => {
    expect(dotScale(1, 1, 0)).not.toBeCloseTo(dotScale(1, 1, 1), 3)
  })

  it('同じ時刻でも、位置が違えば大きさが違う（波が伝わるように見える）', () => {
    expect(dotScale(0, 0, 3)).not.toBeCloseTo(dotScale(2, 1, 3), 3)
  })
})
