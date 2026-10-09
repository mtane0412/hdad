/**
 * 本文を枠に収める計算（fit.ts）のテスト
 *
 * 枠の大きさは固定なので、本文があふれたときの扱いを次の点で確かめる。
 * - 縮める: 収まるいちばん大きな倍率を選び、下限より小さくはしないこと
 * - 流す: あふれたときだけ、枠の右端から本文の右端が抜けるまで一定の速さで流すこと
 * - 流す本文は1行にまとめること（改行は全角の空白に置き換え、空行は詰める）
 */
import { describe, expect, it } from 'vitest'
import { largestFittingScale, marqueeLine, marqueeMotion } from './fit'

describe('largestFittingScale', () => {
  it('そのままで収まるなら、倍率は1のまま', () => {
    expect(largestFittingScale(() => true, 0.4)).toBe(1)
  })

  it('収まらないなら、収まるいちばん大きな倍率まで縮める', () => {
    // 前提: 倍率0.6以下なら収まる本文
    const scale = largestFittingScale((candidate) => candidate <= 0.6, 0.4)

    expect(scale).toBeLessThanOrEqual(0.6)
    expect(scale).toBeGreaterThan(0.58)
  })

  it('下限まで縮めても収まらないなら、下限で止める（読めないほど小さくしない）', () => {
    expect(largestFittingScale(() => false, 0.4)).toBe(0.4)
  })
})

describe('marqueeMotion', () => {
  it('本文が枠に収まっていれば流さない', () => {
    expect(marqueeMotion(600, 400, 120)).toBeNull()
  })

  it('あふれたら、枠の右端から本文の右端が抜けるまでを一定の速さで流す', () => {
    // 前提: 枠600px・本文1200px・毎秒120px なら、1800px を15秒で流す
    expect(marqueeMotion(600, 1200, 120)).toEqual({ from: 600, to: -1200, durationMs: 15_000 })
  })
})

describe('marqueeLine', () => {
  it('改行を全角の空白に置き換えて1行にし、空行は詰める', () => {
    expect(marqueeLine('今日のゴール\n・ログイン画面を作る\n\n・テストを通す')).toBe('今日のゴール　・ログイン画面を作る　・テストを通す')
  })
})
