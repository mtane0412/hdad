/**
 * 日本地図（TopoJSON）の読み解き
 *
 * 同梱の地図（public/town-tour/japan.topo.json。scripts/town-tour/build-data.ts が N03 から作る）を、
 * 市町村のコードごとの輪（多角形の外周・穴）の列にする。素材「市町村紹介」はこれを Canvas 2D で塗る。
 *
 * TopoJSON の読み方のうち、この地図が使う範囲だけを読む（topojson-client を持ち込まない）。
 * - 弧は量子化され、点は直前の点からの差分で書かれている。transform（scale・translate）で経緯度へ戻す
 * - 多角形の輪は弧の番号の列で、負の番号（~i）は弧 i を逆向きにたどる
 *
 * 経緯度は、北緯36度での東西と南北の縮み方をそろえる簡単な投影（正距円筒図法）で平面へ移す。
 * 日本の範囲ならこれで形が大きく崩れず、ズームしても線の太さが縦横で変わらない。
 *
 * 注意: 想定した形でなければ投げる（Fail-Fast）。どの市町村か分からない形を黙って捨てると、引いた市町村が地図に出ないことに
 * 配信中まで気付けない。
 */
import { isRecord } from '../core/api'

/** 平面上の点（東が x の正、北が y の負。Canvas の座標と同じ向き） */
export type Point = readonly [number, number]

/** 輪（閉じた折れ線）。最後の点から最初の点へ戻して閉じる */
export type Ring = readonly Point[]

/** 輪の列を囲む範囲 */
export interface Bounds {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

/** 投影の基準の緯度（度）。日本の真ん中あたり */
const REFERENCE_LATITUDE = 36
const DEGREES_TO_RADIANS = Math.PI / 180

/** 経度1度ぶんの東西の長さを、緯度1度ぶんの南北の長さに対する比で表したもの */
export const LON_SCALE = Math.cos(REFERENCE_LATITUDE * DEGREES_TO_RADIANS)

const isPair = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number'

const isNumberList = (value: unknown): value is number[] => Array.isArray(value) && value.every((item) => typeof item === 'number')

/** 弧を経緯度に戻して投影した点の列にする。点は直前の点からの差分で書かれている */
const decodeArcs = (arcs: unknown, scale: Point, translate: Point): Point[][] => {
  if (!Array.isArray(arcs)) throw new Error('日本地図の arcs が配列ではありません')
  return arcs.map((arc: unknown, index) => {
    if (!Array.isArray(arc)) throw new Error(`日本地図の arcs[${index}] が配列ではありません`)
    let x = 0
    let y = 0
    return arc.map((delta: unknown): Point => {
      if (!isPair(delta)) throw new Error(`日本地図の arcs[${index}] に、数の組でない点があります`)
      x += delta[0]
      y += delta[1]
      const lon = x * scale[0] + translate[0]
      const lat = y * scale[1] + translate[1]
      return [lon * LON_SCALE, -lat]
    })
  })
}

/** 弧の番号の列をつないで輪にする。負の番号（~i）は弧 i を逆向きにたどる */
const ringOf = (arcIndexes: unknown, arcs: readonly Point[][]): Ring => {
  if (!isNumberList(arcIndexes)) throw new Error('日本地図の輪が、弧の番号の列ではありません')
  return arcIndexes.flatMap((index) => {
    const arc = arcs[index < 0 ? ~index : index]
    if (arc === undefined) throw new Error(`日本地図に無い弧の番号を指しています: ${index}`)
    return index < 0 ? [...arc].reverse() : arc
  })
}

/** 形（Polygon・MultiPolygon）を輪の列にする */
const ringsOf = (geometry: Record<string, unknown>, arcs: readonly Point[][]): Ring[] => {
  const polygonOf = (rings: unknown): Ring[] => {
    if (!Array.isArray(rings)) throw new Error('日本地図の多角形が、輪の列ではありません')
    return rings.map((ring: unknown) => ringOf(ring, arcs))
  }
  if (geometry.type === 'Polygon') return polygonOf(geometry.arcs)
  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.arcs)) return geometry.arcs.flatMap((polygon: unknown) => polygonOf(polygon))
  throw new Error(`日本地図に、多角形でない形があります: ${String(geometry.type)}`)
}

/**
 * 同梱の日本地図を、市町村のコードごとの輪の列にする。
 *
 * @throws 想定した形（objects.towns の GeometryCollection、各形が properties.code を持つ）でない場合
 */
export const decodeTownShapes = (topology: unknown): ReadonlyMap<string, readonly Ring[]> => {
  if (!isRecord(topology) || !isRecord(topology.transform)) throw new Error('日本地図が、量子化した TopoJSON ではありません')
  const { scale, translate } = topology.transform
  if (!isPair(scale) || !isPair(translate)) throw new Error('日本地図の transform が数の組ではありません')
  const towns = isRecord(topology.objects) ? topology.objects.towns : undefined
  if (!isRecord(towns) || !Array.isArray(towns.geometries)) throw new Error('日本地図に、市町村の形の一覧（objects.towns）がありません')

  const arcs = decodeArcs(topology.arcs, scale, translate)
  return new Map(
    towns.geometries.map((geometry: unknown, index): [string, Ring[]] => {
      const code = isRecord(geometry) && isRecord(geometry.properties) ? geometry.properties.code : undefined
      if (!isRecord(geometry) || typeof code !== 'string') throw new Error(`日本地図の形 ${index} に、市町村のコードがありません`)
      return [code, ringsOf(geometry, arcs)]
    }),
  )
}

/** 輪の列のすべての点を囲む範囲を返す */
export const boundsOf = (rings: readonly Ring[]): Bounds => {
  const points = rings.flat()
  if (points.length === 0) throw new Error('点を1つも持たない形の範囲は決められません')
  // Math.min(...points) は点が多いと引数の数の上限を超えるので、1点ずつ広げる
  return points.reduce<Bounds>(
    (bounds, [x, y]) => ({
      minX: Math.min(bounds.minX, x),
      minY: Math.min(bounds.minY, y),
      maxX: Math.max(bounds.maxX, x),
      maxY: Math.max(bounds.maxY, y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  )
}
