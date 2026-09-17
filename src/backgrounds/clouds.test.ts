/**
 * clouds（もこもこ雲）の雲の形の計算に対するテスト
 *
 * 雲は、底を同じ高さ（y=0）に揃えた円（こぶ）を横に並べて作る。
 * 座標は雲の幅をおよそ1とした比率で、y は上が負。
 */
import { describe, expect, it } from 'vitest'
import { createRandom } from '../core/background'
import { createCloudPuffs } from './clouds'

describe('createCloudPuffs（雲を形作るこぶの並び）', () => {
  it('同じ乱数の種からは同じ形の雲ができる（再読み込みしても形が変わらない）', () => {
    expect(createCloudPuffs(createRandom(12))).toEqual(createCloudPuffs(createRandom(12)))
  })

  it('こぶは3〜5個で、左から右へ順に並ぶ', () => {
    for (let seed = 0; seed < 50; seed++) {
      const puffs = createCloudPuffs(createRandom(seed))
      expect(puffs.length).toBeGreaterThanOrEqual(3)
      expect(puffs.length).toBeLessThanOrEqual(5)
      const xs = puffs.map((puff) => puff.x)
      expect(xs).toEqual([...xs].sort((a, b) => a - b))
    }
  })

  it('すべてのこぶの底が同じ高さ（y=0）に揃う（雲の底が平らになる）', () => {
    for (const puff of createCloudPuffs(createRandom(34))) {
      expect(puff.y + puff.radius).toBeCloseTo(0)
    }
  })

  it('両端のこぶより内側のこぶのほうが大きい（真ん中が盛り上がった形になる）', () => {
    for (let seed = 0; seed < 50; seed++) {
      const radii = createCloudPuffs(createRandom(seed)).map((puff) => puff.radius)
      const 端の最大 = Math.max(...radii.slice(0, 1), ...radii.slice(-1))
      const 内側の最大 = Math.max(...radii.slice(1, -1))
      expect(内側の最大).toBeGreaterThan(端の最大)
    }
  })

  it('隣り合うこぶは必ず重なる（雲がちぎれない）', () => {
    for (let seed = 0; seed < 50; seed++) {
      const puffs = createCloudPuffs(createRandom(seed))
      // 左隣のこぶと1つずつ見比べる
      puffs.slice(1).forEach((puff, index) => {
        const 左隣 = puffs[index]
        if (!左隣) throw new Error('左隣のこぶがありません')
        expect(puff.x - 左隣.x).toBeLessThan(puff.radius + 左隣.radius)
      })
    }
  })
})
