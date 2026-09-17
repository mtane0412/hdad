/**
 * truchet（タイル曲線）のタイルの回転量の計算に対するテスト
 *
 * 回転量の単位は「4分の1回転（90度）」。整数のときタイルの曲線は隣のタイルとつながる。
 * cycle は「経過時間 × 回転の頻度 + タイルごとのずれ」で、1進むごとに90度回る。
 */
import { describe, expect, it } from 'vitest'
import { tileQuarterTurns, tilePhase } from './truchet'

describe('tileQuarterTurns（タイルの回転量）', () => {
  it('cycle が整数のとき、回転量も同じ整数になる（曲線がつながった状態）', () => {
    expect(tileQuarterTurns(0)).toBe(0)
    expect(tileQuarterTurns(3)).toBe(3)
  })

  it('cycle の前半は回転せず、止まったままになる', () => {
    expect(tileQuarterTurns(2.1)).toBe(2)
    expect(tileQuarterTurns(2.5)).toBe(2)
  })

  it('cycle の終わりに向けて、次の整数へなめらかに近づく', () => {
    expect(tileQuarterTurns(2.999)).toBeCloseTo(3, 2)
  })

  it('cycle が進んでも回転量が戻ることはない（逆回転しない）', () => {
    let previous = tileQuarterTurns(0)
    for (let cycle = 0; cycle < 3; cycle += 0.01) {
      const current = tileQuarterTurns(cycle)
      expect(current).toBeGreaterThanOrEqual(previous)
      previous = current
    }
  })
})

describe('tilePhase（タイルごとの回転タイミングのずれ、0〜1）', () => {
  it('同じ列・行のタイルは、いつ計算しても同じ値になる', () => {
    expect(tilePhase(3, 7)).toBe(tilePhase(3, 7))
  })

  it('0以上1未満に収まる', () => {
    for (let column = 0; column < 20; column++) {
      for (let row = 0; row < 12; row++) {
        const phase = tilePhase(column, row)
        expect(phase).toBeGreaterThanOrEqual(0)
        expect(phase).toBeLessThan(1)
      }
    }
  })

  it('タイルごとに値がばらける（全タイルが同時に回らない）', () => {
    const phases = new Set<number>()
    for (let column = 0; column < 10; column++) {
      for (let row = 0; row < 10; row++) phases.add(tilePhase(column, row))
    }
    expect(phases.size).toBeGreaterThan(90)
  })
})
