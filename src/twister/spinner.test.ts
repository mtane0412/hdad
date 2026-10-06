/**
 * スピナー（spinner.ts）のテスト
 *
 * スピナーの盤は手足ごとに4つに分かれ、それぞれが4色に分かれる（16区画）。
 * 針は勢いよく回ってから、指示の手足と色の区画の真ん中で止まる。針の角度は回しはじめからの経過時間だけから決まる。
 */
import { describe, expect, it } from 'vitest'
import { LIMBS } from './body'
import { MAT_COLORS } from './mat'
import { SPIN_TURN_MS, spinnerAngleAt, spinnerSegmentAt, spinnerTargetAngle } from './spinner'

describe('spinnerTargetAngle', () => {
  it('どの手足と色の組でも、止まる角度の区画はその組になる', () => {
    for (const limb of LIMBS) {
      for (const color of MAT_COLORS) {
        expect(spinnerSegmentAt(spinnerTargetAngle(limb, color))).toEqual({ limb, color })
      }
    }
  })
})

describe('spinnerAngleAt', () => {
  const target = { limb: 'footR', color: 'blue' } as const

  it('回し終えたら、指示の区画の真ん中で止まっている', () => {
    expect(spinnerAngleAt(target, SPIN_TURN_MS)).toBeCloseTo(spinnerTargetAngle('footR', 'blue'), 9)
    expect(spinnerAngleAt(target, SPIN_TURN_MS * 3)).toBeCloseTo(spinnerTargetAngle('footR', 'blue'), 9)
  })

  it('回っているあいだ、針は一方向へ進み続ける（戻らない）', () => {
    let previous = spinnerAngleAt(target, 0)
    for (let elapsed = 50; elapsed <= SPIN_TURN_MS; elapsed += 50) {
      const angle = spinnerAngleAt(target, elapsed)
      expect(angle).toBeGreaterThanOrEqual(previous)
      previous = angle
    }
  })

  it('回しはじめは、止まる角度より少なくとも2回転ぶん手前にある', () => {
    expect(spinnerTargetAngle('footR', 'blue') - spinnerAngleAt(target, 0)).toBeGreaterThanOrEqual(Math.PI * 4)
  })
})
