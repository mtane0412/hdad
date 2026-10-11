/**
 * ベクトルの計算（vec.ts）のテスト
 *
 * 上から見て2本の線分が交差するかの判定（segmentsCrossFlat）と、上から見た2本の線分のあいだの距離（segmentDistanceFlat）を確かめる。
 * どちらも高さ（y）は見ない。3次元の2本の線分のあいだの距離（segmentDistance）も確かめる。
 */
import { describe, expect, it } from 'vitest'
import { segmentDistance, segmentDistanceFlat, segmentsCrossFlat, vec } from './vec'

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

describe('segmentDistanceFlat', () => {
  it('上から見て交差する2本は、高さが違っても距離 0', () => {
    expect(segmentDistanceFlat(vec(-1, 0, 0), vec(1, 0, 0), vec(0, 0.5, -1), vec(0, 0.5, 1))).toBeCloseTo(0, 9)
  })

  it('平行に並んだ2本は、そのあいだの幅が距離になる', () => {
    expect(segmentDistanceFlat(vec(-1, 0, 0), vec(1, 0, 0), vec(-1, 0.3, 0.4), vec(1, 0.3, 0.4))).toBeCloseTo(0.4, 9)
  })

  it('離れた2本は、近い端から相手の線分までの距離になる', () => {
    // 2本目の手前の端 (0, 0, 0.5) から、1本目（x 軸の -1〜1）までの距離
    expect(segmentDistanceFlat(vec(-1, 0, 0), vec(1, 0, 0), vec(0, 0, 0.5), vec(0, 0, 2))).toBeCloseTo(0.5, 9)
    // 2本目は1本目の延長の先にある。1本目の端 (1, 0, 0) から2本目の端 (2, 0, 0) までの距離
    expect(segmentDistanceFlat(vec(-1, 0, 0), vec(1, 0, 0), vec(2, 0, 0), vec(3, 0, 0))).toBeCloseTo(1, 9)
  })
})

describe('segmentDistance', () => {
  it('ねじれの位置にある2本は、高さの差だけ離れている', () => {
    expect(segmentDistance(vec(-1, 0, 0), vec(1, 0, 0), vec(0, 0.3, -1), vec(0, 0.3, 1))).toBeCloseTo(0.3, 9)
  })

  it('交わる2本の距離は 0', () => {
    expect(segmentDistance(vec(-1, 0, 0), vec(1, 0, 0), vec(0, -1, 0), vec(0, 1, 0))).toBeCloseTo(0, 9)
  })

  it('端どうしがいちばん近い2本は、端のあいだの距離になる', () => {
    expect(segmentDistance(vec(0, 0, 0), vec(1, 0, 0), vec(2, 0, 0), vec(3, 0, 0))).toBeCloseTo(1, 9)
  })

  it('平行な2本は、そのあいだの幅だけ離れている', () => {
    expect(segmentDistance(vec(0, 0, 0), vec(1, 0, 0), vec(0, 0, 0.5), vec(1, 0, 0.5))).toBeCloseTo(0.5, 9)
  })
})
