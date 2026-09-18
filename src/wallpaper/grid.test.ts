/**
 * grid（遠近グリッド）の奥行き計算に対するテスト
 *
 * 奥行き（depth）は「1 = 画面の下端、大きいほど地平線に近い」という値。
 */
import { describe, expect, it } from 'vitest'
import { gridDepths, projectDepth } from './grid'

describe('projectDepth（奥行きから画面上の縦位置への変換）', () => {
  // 前提: 地平線が y=400、床の高さが 600px（画面の下端は y=1000）
  const horizonY = 400
  const floorHeight = 600

  it('奥行き1の線は画面の下端に来る', () => {
    expect(projectDepth(1, horizonY, floorHeight)).toBe(1000)
  })

  it('奥行き2の線は地平線と下端のちょうど中間に来る', () => {
    expect(projectDepth(2, horizonY, floorHeight)).toBe(700)
  })

  it('奥行きが大きいほど地平線に近づくが、地平線は越えない', () => {
    const far = projectDepth(1000, horizonY, floorHeight)
    expect(far).toBeGreaterThan(horizonY)
    expect(far).toBeLessThan(projectDepth(10, horizonY, floorHeight))
  })
})

describe('gridDepths（横線の奥行きの一覧）', () => {
  it('手前から奥へ、一定の間隔（depthStep）で並ぶ', () => {
    // 前提: 位相0、線の間隔0.5、最大の奥行き3
    expect(gridDepths(0, 0.5, 3)).toEqual([1.5, 2, 2.5, 3])
  })

  it('位相が進むと、すべての線が手前（奥行き1の側）へ寄る', () => {
    expect(gridDepths(0.5, 0.5, 2.5)).toEqual([1.25, 1.75, 2.25])
  })

  it('位相が1に近づいたときの並びは、位相0の並びへなめらかにつながる', () => {
    // 検証: 位相0.999の2本目以降が、位相0の1本目以降とほぼ同じ位置にある
    const beforeWrap = gridDepths(0.999, 0.5, 3)
    const afterWrap = gridDepths(0, 0.5, 3)
    expect(beforeWrap[0]).toBeCloseTo(1, 2)
    expect(beforeWrap[1]).toBeCloseTo(afterWrap[0] ?? Number.NaN, 2)
  })

  it('どの線も画面内（奥行き1以上、最大の奥行き以下）に収まる', () => {
    for (const depth of gridDepths(0.37, 0.21, 30)) {
      expect(depth).toBeGreaterThanOrEqual(1)
      expect(depth).toBeLessThanOrEqual(30)
    }
  })
})
