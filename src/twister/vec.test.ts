/**
 * ベクトルの計算（vec.ts）のテスト
 *
 * ここでは、上から見て2本の線分が交差するかの判定（segmentsCrossFlat）だけを確かめる。高さ（y）は見ない。
 */
import { describe, expect, it } from 'vitest'
import { segmentsCrossFlat, vec } from './vec'

describe('segmentsCrossFlat', () => {
  it('上から見て X の形に交わる2本は、高さが違っても交差とみなす', () => {
    expect(segmentsCrossFlat(vec(-1, 0, 0), vec(1, 0, 0), vec(0, 0.5, -1), vec(0, 0.5, 1))).toBe(true)
  })

  it('平行な2本は交差しない', () => {
    expect(segmentsCrossFlat(vec(-1, 0, 0), vec(1, 0, 0), vec(-1, 0, 1), vec(1, 0, 1))).toBe(false)
  })

  it('延ばせば交わるが、線分の範囲では交わらない2本は交差しない', () => {
    expect(segmentsCrossFlat(vec(-1, 0, 0), vec(1, 0, 0), vec(0, 0, 0.5), vec(0, 0, 2))).toBe(false)
  })

  it('端どうしが触れているだけの2本は交差しない（同じ付け根から出た手足を数えないように）', () => {
    expect(segmentsCrossFlat(vec(0, 0, 0), vec(1, 0, 0), vec(0, 0, 0), vec(0, 0, 1))).toBe(false)
  })
})
