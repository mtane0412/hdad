/**
 * 日本地図（TopoJSON）の読み解き（topo.ts）のテスト
 *
 * 小さな地図を手で書いて、量子化と差分の復元・弧の向き・投影・範囲の計算を確かめる。
 * 同梱の地図そのものが読めることも1件だけ確かめる（生成物の形が変わったら気付けるように）。
 * 海に面しているか・隣り合う市町村（decodeTownBorders）は、穴（どの市町村にも属さない土地）を持つ小さな地図と、同梱の地図で確かめる。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import towns from './towns.json'
import { LON_SCALE, boundsOf, decodeTownBorders, decodeTownShapes } from './topo'

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

/** 絶対座標の点の列を、TopoJSON の弧（最初の点のあとは直前の点からの差分）に書き直す */
const arcOf = (points: readonly (readonly [number, number])[]): [number, number][] =>
  points.map(([x, y], index) => {
    const previous = points[index - 1]
    return previous === undefined ? [x, y] : [x - previous[0], y - previous[1]]
  })

/**
 * 穴と島を持つ小さな地図（量子化した座標。北が y の正）。輪の向きは同梱の地図と同じく、外周が時計回り・穴が反時計回り。
 *
 * - 町R（01001）: (0,0)〜(4,4) の正方形から、真ん中の (1,1)〜(3,3) をくり抜いた形。外周が海に面する
 * - 町C（02001）: くり抜いた所の下半分 (1,1)〜(3,2)。上半分 (1,2)〜(3,3) はどの市町村にも属さない土地（境界未定地や湖にあたる）で、
 *   町Cは海に面していない
 * - 町I（03001）: 離れた島 (5,0)〜(6,1)
 */
const borderTopology = {
  type: 'Topology',
  transform: { scale: [1, 1], translate: [0, 0] },
  arcs: [
    arcOf([[0, 0], [0, 4], [4, 4], [4, 0], [0, 0]]),
    arcOf([[1, 1], [3, 1]]),
    arcOf([[3, 1], [3, 2]]),
    arcOf([[3, 2], [3, 3], [1, 3], [1, 2]]),
    arcOf([[1, 2], [1, 1]]),
    arcOf([[1, 2], [3, 2]]),
    arcOf([[5, 0], [5, 1], [6, 1], [6, 0], [5, 0]]),
  ],
  objects: {
    towns: {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Polygon', arcs: [[0], [1, 2, 3, 4]], properties: { code: '01001' } },
        { type: 'Polygon', arcs: [[~4, 5, ~2, ~1]], properties: { code: '02001' } },
        { type: 'Polygon', arcs: [[6]], properties: { code: '03001' } },
      ],
    },
  },
}

describe('decodeTownBorders', () => {
  it('どの市町村とも分け合わない境界のうち、外周（海岸線）を持つ市町村を海に面しているとする', () => {
    const { coastal } = decodeTownBorders(borderTopology)

    // 町Cの上辺も分け合わない境界だが、どの市町村にも属さない土地の縁なので海岸線ではない
    expect([...coastal].sort()).toEqual(['01001', '03001'])
  })

  it('境界を分け合う市町村どうしを隣り合うとする', () => {
    const { adjacent } = decodeTownBorders(borderTopology)

    expect([...(adjacent.get('01001') ?? [])]).toEqual(['02001'])
    expect([...(adjacent.get('02001') ?? [])]).toEqual(['01001'])
    // 島はどの市町村とも隣り合わない
    expect([...(adjacent.get('03001') ?? [])]).toEqual([])
  })

  it('同梱の日本地図で、海沿いの市と内陸の町村を見分ける（県境の未定地を海と取り違えない）', () => {
    const topology: unknown = JSON.parse(readFileSync(new URL('../../public/town-tour/japan.topo.json', import.meta.url), 'utf8'))

    const { coastal } = decodeTownBorders(topology)

    // 横浜市は海沿い、札幌市・十和田市（十和田湖に面する）は内陸
    expect(coastal.has('14100')).toBe(true)
    expect(coastal.has('01100')).toBe(false)
    expect(coastal.has('02206')).toBe(false)
    // 群馬県嬬恋村・埼玉県秩父市は、県境に未定地があるが内陸
    expect(coastal.has('10425')).toBe(false)
    expect(coastal.has('11207')).toBe(false)
  })
})
