/**
 * 舌の模様（texture.ts）のテスト
 *
 * 表は乳頭のブツブツ・中央の溝・奥の白っぽい苔、裏は青い血管を、画素の並び（RGBA）としてコードで作る。
 * 行の並びは根元（0行目）から舌先（最後の行）、列の並びは左端から右端（真ん中が溝）。
 */
import { describe, expect, it } from 'vitest'
import { tongueBottomTexture, tongueTopTexture } from './texture'

const SIZE = 128

/** 画素1つの RGBA */
const pixelAt = (data: Uint8ClampedArray, x: number, y: number): readonly [number, number, number, number] => {
  const index = (y * SIZE + x) * 4
  return [data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0, data[index + 3] ?? 0]
}

/** 範囲の画素の、ある成分の平均 */
const average = (data: Uint8ClampedArray, columns: readonly number[], rows: readonly number[], channel: 0 | 1 | 2): number => {
  let sum = 0
  for (const y of rows) for (const x of columns) sum += pixelAt(data, x, y)[channel]
  return sum / (columns.length * rows.length)
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from }, (_, index) => from + index)

describe('tongueTopTexture', () => {
  const texture = tongueTopTexture(SIZE, 7)

  it('同じ種なら同じ模様になる', () => {
    expect(tongueTopTexture(SIZE, 7)).toEqual(texture)
  })

  it('色と凹凸の画素を、大きさの2乗ぶん持つ', () => {
    expect(texture.color).toHaveLength(SIZE * SIZE * 4)
    expect(texture.bump).toHaveLength(SIZE * SIZE * 4)
  })

  it('真ん中の溝は、少し横より低く暗い', () => {
    const rows = range(30, 100)
    const center = [SIZE / 2 - 1, SIZE / 2]
    const side = [Math.round(SIZE * 0.3)]
    expect(average(texture.bump, center, rows, 0)).toBeLessThan(average(texture.bump, side, rows, 0))
    expect(average(texture.color, center, rows, 0)).toBeLessThan(average(texture.color, side, rows, 0))
  })

  it('奥（根元）は苔で白っぽく、舌先より緑と青が多い', () => {
    const columns = range(20, 50)
    const root = range(0, 20)
    const tip = range(SIZE - 30, SIZE - 10)
    expect(average(texture.color, columns, root, 1)).toBeGreaterThan(average(texture.color, columns, tip, 1))
    expect(average(texture.color, columns, root, 2)).toBeGreaterThan(average(texture.color, columns, tip, 2))
  })

  it('乳頭のブツブツで、凹凸に細かなむらがある', () => {
    const row = range(0, SIZE).map((x) => pixelAt(texture.bump, x, 70)[0])
    const changes = row.slice(1).filter((value, index) => Math.abs(value - (row[index] ?? value)) >= 8).length
    expect(changes).toBeGreaterThan(10)
  })
})

describe('tongueBottomTexture', () => {
  const texture = tongueBottomTexture(SIZE, 7)

  it('同じ種なら同じ模様になる', () => {
    expect(tongueBottomTexture(SIZE, 7)).toEqual(texture)
  })

  it('真ん中の左右に、赤より青の強い血管が通る', () => {
    const veinPixels = range(0, SIZE)
      .flatMap((y) => range(Math.round(SIZE * 0.2), Math.round(SIZE * 0.8)).map((x) => pixelAt(texture.color, x, y)))
      .filter(([red, , blue]) => blue > red)
    expect(veinPixels.length).toBeGreaterThan(SIZE)
  })
})
