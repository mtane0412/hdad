/**
 * 舌の形（tongue-shape.ts）のテスト
 *
 * 舌の表面の1点を、長さの向きの位置 u（0: 根元、1: 舌先）・幅の向きの位置 v（-1: 左端、1: 右端）・表か裏かと、
 * その時刻の舌の様子（長さ・押しつぶれ・丸め）から求める。舌先を原点に置き、根元は y の負の側、表（乳頭のある側）は z の正の側を向く。
 */
import { describe, expect, it } from 'vitest'
import { tongueSurfacePoint, type TonguePose } from './tongue-shape'

/** 押しつぶれも丸めもしていない、出しきった舌 */
const relaxed: TonguePose = { length: 1.7, squash: 0, curl: 0 }

describe('tongueSurfacePoint', () => {
  it('舌先は原点に、根元は長さの分だけ下にある', () => {
    const tip = tongueSurfacePoint(1, 0, 'top', relaxed)
    expect(tip.x).toBeCloseTo(0)
    expect(tip.y).toBeCloseTo(0)
    expect(tongueSurfacePoint(0, 0, 'top', relaxed).y).toBeCloseTo(-1.7)
  })

  it('表の真ん中には溝があり、少し横より低い', () => {
    expect(tongueSurfacePoint(0.5, 0, 'top', relaxed).z).toBeLessThan(tongueSurfacePoint(0.5, 0.4, 'top', relaxed).z)
  })

  it('表は手前（z の正）、裏は奥（z の負）にふくらむ', () => {
    expect(tongueSurfacePoint(0.5, 0.4, 'top', relaxed).z).toBeGreaterThan(0)
    expect(tongueSurfacePoint(0.5, 0.4, 'bottom', relaxed).z).toBeLessThan(0)
  })

  it('左右は対称になる', () => {
    const right = tongueSurfacePoint(0.6, 0.7, 'top', relaxed)
    const left = tongueSurfacePoint(0.6, -0.7, 'top', relaxed)
    expect(left.x).toBeCloseTo(-right.x)
    expect(left.z).toBeCloseTo(right.z)
  })

  it('舌先は丸く細まり、なかほどがいちばん広い', () => {
    const widthAt = (u: number): number => tongueSurfacePoint(u, 1, 'top', relaxed).x
    expect(widthAt(1)).toBeCloseTo(0)
    expect(widthAt(0.6)).toBeGreaterThan(widthAt(0.1))
    expect(widthAt(0.6)).toBeGreaterThan(widthAt(0.95))
  })

  it('押しつぶれると、舌先のあたりが平たく広がる（根元は変わらない）', () => {
    const squashed: TonguePose = { ...relaxed, squash: 1 }
    expect(tongueSurfacePoint(0.8, 1, 'top', squashed).x).toBeGreaterThan(tongueSurfacePoint(0.8, 1, 'top', relaxed).x)
    expect(tongueSurfacePoint(0.8, 0.4, 'top', squashed).z).toBeLessThan(tongueSurfacePoint(0.8, 0.4, 'top', relaxed).z)
    expect(tongueSurfacePoint(0.05, 1, 'top', squashed).x).toBeCloseTo(tongueSurfacePoint(0.05, 1, 'top', relaxed).x)
  })

  it('丸めると、舌先が手前へ巻き上がる（根元は動かない）', () => {
    const curled: TonguePose = { ...relaxed, curl: 1 }
    // 舌先は、舌の長さの1割より手前まで巻き上がる
    expect(tongueSurfacePoint(1, 0, 'top', curled).z).toBeGreaterThan(relaxed.length * 0.1)
    expect(tongueSurfacePoint(1, 0, 'top', curled).y).toBeLessThan(0)
    const root = tongueSurfacePoint(0, 0, 'top', curled)
    expect(root.y).toBeCloseTo(tongueSurfacePoint(0, 0, 'top', relaxed).y)
  })
})
