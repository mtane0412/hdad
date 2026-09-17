/**
 * waves（重なる波）の波形計算に対するテスト
 */
import { describe, expect, it } from 'vitest'
import { layerBaseline, waveOffset } from './waves'

describe('waveOffset（波の上下のずれ、-1〜1）', () => {
  it('どの位置・層・時刻でも -1〜1 に収まる', () => {
    for (let layer = 0; layer < 8; layer++) {
      for (let x = 0; x < 10; x += 0.37) {
        const offset = waveOffset(x, layer, x * 13)
        expect(offset).toBeGreaterThanOrEqual(-1)
        expect(offset).toBeLessThanOrEqual(1)
      }
    }
  })

  it('同じ位置・同じ時刻でも、層が違えば波の形が違う', () => {
    expect(waveOffset(1.2, 0, 5)).not.toBeCloseTo(waveOffset(1.2, 1, 5), 3)
  })

  it('時間が進むと波の形が変わる', () => {
    expect(waveOffset(1.2, 0, 0)).not.toBeCloseTo(waveOffset(1.2, 0, 4), 3)
  })
})

describe('layerBaseline（層の基準の高さ、画面の高さに対する比率）', () => {
  it('奥の層（0番）ほど上、手前の層ほど下に並ぶ', () => {
    // 前提: 4層の波
    const baselines = [0, 1, 2, 3].map((layer) => layerBaseline(layer, 4))
    expect(baselines).toEqual([...baselines].sort((a, b) => a - b))
    expect(new Set(baselines).size).toBe(4)
  })

  it('1層だけでも計算できる（0で割らない）', () => {
    expect(Number.isFinite(layerBaseline(0, 1))).toBe(true)
  })

  it('すべての層が画面内（0〜1）に収まる', () => {
    for (let layer = 0; layer < 8; layer++) {
      const baseline = layerBaseline(layer, 8)
      expect(baseline).toBeGreaterThan(0)
      expect(baseline).toBeLessThan(1)
    }
  })
})
