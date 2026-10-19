/**
 * スピナー（spinner.ts）のテスト
 *
 * スピナーの盤は手足ごとに4つに分かれ、それぞれが4色に分かれる（16区画）。
 * 針は勢いよく回ってから、指示の手足と色の区画の真ん中で止まる。針の角度は回しはじめからの経過時間だけから決まる。
 */
import { describe, expect, it } from 'vitest'
import { LIMBS } from './body'
import { MAT_COLORS } from './mat'
import { SPINNER_GROW_MS, SPINNER_SHRINK_MS, spinnerAngleAt, spinnerSegmentAt, spinnerTargetAngle, spinnerZoomAt } from './spinner'

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

describe('spinnerZoomAt', () => {
  /** スピナーを回して結果を見せる長さ（ミリ秒）。この後は手足を運ぶ場面になる */
  const spinMs = 2600

  it('回しはじめに小さい（0）から大きく（1）なり、結果を見せ終えるまで大きいまま', () => {
    expect(spinnerZoomAt(0, spinMs)).toBe(0)
    expect(spinnerZoomAt(SPINNER_GROW_MS, spinMs)).toBe(1)
    expect(spinnerZoomAt(spinMs / 2, spinMs)).toBe(1)
    expect(spinnerZoomAt(spinMs, spinMs)).toBe(1)
  })

  it('手足を運ぶ場面に入ったら小さく戻り、縮み終えたあとは小さいまま', () => {
    expect(spinnerZoomAt(spinMs + SPINNER_SHRINK_MS, spinMs)).toBe(0)
    expect(spinnerZoomAt(spinMs + SPINNER_SHRINK_MS * 4, spinMs)).toBe(0)
  })

  it('大きくなる途中と縮む途中は、飛ばずに少しずつ変わる', () => {
    // 大きくなる途中は増え続け、縮む途中は減り続ける。1回の変わり幅は全体の半分より小さい
    const growing = [0, 0.25, 0.5, 0.75, 1].map((ratio) => spinnerZoomAt(SPINNER_GROW_MS * ratio, spinMs))
    const shrinking = [0, 0.25, 0.5, 0.75, 1].map((ratio) => spinnerZoomAt(spinMs + SPINNER_SHRINK_MS * ratio, spinMs))
    growing.slice(1).forEach((zoom, index) => {
      expect(zoom).toBeGreaterThan(growing[index] ?? Number.NaN)
      expect(zoom - (growing[index] ?? Number.NaN)).toBeLessThan(0.5)
    })
    shrinking.slice(1).forEach((zoom, index) => {
      expect(zoom).toBeLessThan(shrinking[index] ?? Number.NaN)
      expect((shrinking[index] ?? Number.NaN) - zoom).toBeLessThan(0.5)
    })
  })

  it('針が止まるまでに大きくなり終えている（回っている針を大きく見せる）', () => {
    // 針が回る長さのうち、いちばん短いもの（1秒）より前に大きくなり終える
    expect(SPINNER_GROW_MS).toBeLessThan(1000)
  })
})
