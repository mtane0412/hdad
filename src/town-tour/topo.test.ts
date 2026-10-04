/**
 * 日本地図（TopoJSON）の読み解き（topo.ts）のテスト
 *
 * 小さな地図を手で書いて、量子化と差分の復元・弧の向き・投影・範囲の計算を確かめる。
 * 同梱の地図そのものが読めることも1件だけ確かめる（生成物の形が変わったら気付けるように）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import towns from './towns.json'
import { LON_SCALE, boundsOf, decodeTownShapes } from './topo'

/**
 * 量子化した弧が2本の小さな地図。
 *
 * 弧0は (130,30) → (131,30) → (131,31)、弧1は (131,31) → (130,31) → (130,30)（どちらも差分で書く）。
 * 町A（01001）は弧0と弧1をつないだ1つの輪、町B（01002）は弧0を逆向きにたどった輪と、弧1だけの輪の2つの多角形からなる。
 */
const tinyTopology = {
  type: 'Topology',
  transform: { scale: [1, 1], translate: [130, 30] },
  arcs: [
    [
      [0, 0],
      [1, 0],
      [0, 1],
    ],
    [
      [1, 1],
      [-1, 0],
      [0, -1],
    ],
  ],
  objects: {
    towns: {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Polygon', arcs: [[0, 1]], properties: { code: '01001' } },
        { type: 'MultiPolygon', arcs: [[[~0]], [[1]]], properties: { code: '01002' } },
      ],
    },
  },
}

/** 経緯度を投影した座標（東西は LON_SCALE を掛け、南北は北を上にするため符号を反転する） */
const projected = (lon: number, lat: number): [number, number] => [lon * LON_SCALE, -lat]

describe('decodeTownShapes', () => {
  it('弧をつないで、市町村のコードごとの輪（投影した座標の列）にする', () => {
    const shapes = decodeTownShapes(tinyTopology)

    expect(shapes.get('01001')).toEqual([
      [projected(130, 30), projected(131, 30), projected(131, 31), projected(131, 31), projected(130, 31), projected(130, 30)],
    ])
  })

  it('負の番号の弧は逆向きにたどり、複数の多角形はそれぞれの輪として並べる', () => {
    const shapes = decodeTownShapes(tinyTopology)

    expect(shapes.get('01002')).toEqual([
      [projected(131, 31), projected(131, 30), projected(130, 30)],
      [projected(131, 31), projected(130, 31), projected(130, 30)],
    ])
  })

  it('市町村の形の一覧（objects.towns）が無ければ投げる', () => {
    expect(() => decodeTownShapes({ ...tinyTopology, objects: {} })).toThrow('日本地図')
  })

  it('コードを持たない形があれば投げる（どの市町村か分からない形を黙って捨てない）', () => {
    const withoutCode = {
      ...tinyTopology,
      objects: { towns: { type: 'GeometryCollection', geometries: [{ type: 'Polygon', arcs: [[0, 1]], properties: {} }] } },
    }

    expect(() => decodeTownShapes(withoutCode)).toThrow('コード')
  })

  it('同梱の日本地図を読むと、一覧のすべての市町村の形がそろう', () => {
    const topology: unknown = JSON.parse(readFileSync(new URL('../../public/town-tour/japan.topo.json', import.meta.url), 'utf8'))

    const shapes = decodeTownShapes(topology)

    expect(towns.filter((town) => !shapes.has(town.code))).toEqual([])
  })
})

describe('boundsOf', () => {
  it('輪のすべての点を囲む範囲を返す', () => {
    expect(
      boundsOf([
        [
          [1, -2],
          [3, -5],
        ],
        [[-1, 0]],
      ]),
    ).toEqual({ minX: -1, minY: -5, maxX: 3, maxY: 0 })
  })
})
