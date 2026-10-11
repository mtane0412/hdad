/**
 * スピナー（spinner.ts）のテスト
 *
 * スピナーの盤は手足ごとに4つに分かれ、それぞれが4色に分かれる（16区画）。
 * 針は勢いよく回ってから、指示の手足と色の区画の真ん中で止まる。針の角度は回しはじめからの経過時間だけから決まる。
 */
import { describe, expect, it } from 'vitest'
import { LIMBS } from './body'
import { MAT_COLORS } from './mat'
import { spinnerAngleAt, spinnerSegmentAt, spinnerTargetAngle } from './spinner'

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
  /** 針が回る長さ（ミリ秒）。はじめの手番のゆっくり回すときと、後半の速く回すときの両方で確かめる */
  const turnLengths = [1800, 1000]

  it('回し終えたら、指示の区画の真ん中で止まっている', () => {
    for (const turnMs of turnLengths) {
      expect(spinnerAngleAt(target, turnMs, turnMs)).toBeCloseTo(spinnerTargetAngle('footR', 'blue'), 9)
      expect(spinnerAngleAt(target, turnMs * 3, turnMs)).toBeCloseTo(spinnerTargetAngle('footR', 'blue'), 9)
    }
  })

  it('回っているあいだ、針は一方向へ進み続ける（戻らない）', () => {
    for (const turnMs of turnLengths) {
      let previous = spinnerAngleAt(target, 0, turnMs)
      for (let elapsed = 50; elapsed <= turnMs; elapsed += 50) {
        const angle = spinnerAngleAt(target, elapsed, turnMs)
        expect(angle).toBeGreaterThanOrEqual(previous)
        previous = angle
      }
    }
  })

  it('回す長さが短いほど、同じ時刻でも止まる角度に近い（速く回る）', () => {
    const remainingOf = (turnMs: number): number => spinnerTargetAngle('footR', 'blue') - spinnerAngleAt(target, 500, turnMs)
    expect(remainingOf(1000)).toBeLessThan(remainingOf(1800))
  })

  it('回しはじめは、止まる角度より少なくとも2回転ぶん手前にある', () => {
    expect(spinnerTargetAngle('footR', 'blue') - spinnerAngleAt(target, 0, 1000)).toBeGreaterThanOrEqual(Math.PI * 4)
  })
})
