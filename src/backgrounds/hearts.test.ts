/**
 * hearts（ふわふわ昇るハート）の傾きの計算に対するテスト
 */
import { describe, expect, it } from 'vitest'
import { HEART_MAX_TILT, heartTilt } from './hearts'

describe('heartTilt（ハートの傾き、ラジアン）', () => {
  it('どの時刻・位相でも、最大の傾き（左右およそ20度）を超えない', () => {
    for (let step = 0; step < 500; step++) {
      const tilt = heartTilt(step * 0.73, step * 0.19)
      expect(Math.abs(tilt)).toBeLessThanOrEqual(HEART_MAX_TILT)
    }
  })

  it('時間が進むと傾きが変わる（ゆらゆら揺れる）', () => {
    expect(heartTilt(0, 0)).not.toBeCloseTo(heartTilt(2, 0), 3)
  })

  it('同じ時刻でも、位相が違うハートは傾きが違う（全部が同じ向きに揃わない）', () => {
    expect(heartTilt(5, 0)).not.toBeCloseTo(heartTilt(5, 1.5), 3)
  })
})
