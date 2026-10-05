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
 * 都道府県当てクイズ（issue #251）のヒントのために、市町村の境界の分け合い方も読む（decodeTownBorders）。
 * - 2つの市町村が同じ弧を使っていれば、その2つは隣り合う
 * - どの市町村とも分け合わない弧は、全国の陸地の縁である。縁には海岸線のほかに、どの市町村にも属さない土地
 *   （県境の未定地・湖）の縁も含まれる。縁の弧を輪につなぎ、輪の向きが市町村の外周と同じなら海岸線、逆なら穴の縁と見分ける
 *   （市町村はどれも自分の内側を同じ側に見て境界をたどるので、穴を囲む輪だけが逆回りになる）
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

/** 弧を、量子化した座標のままの点の列にする。点は直前の点からの差分で書かれているので足し合わせる */
const quantizedArcsOf = (arcs: unknown): Point[][] => {
  if (!Array.isArray(arcs)) throw new Error('日本地図の arcs が配列ではありません')
  return arcs.map((arc: unknown, index) => {
    if (!Array.isArray(arc)) throw new Error(`日本地図の arcs[${index}] が配列ではありません`)
    let x = 0
    let y = 0
    return arc.map((delta: unknown): Point => {
      if (!isPair(delta)) throw new Error(`日本地図の arcs[${index}] に、数の組でない点があります`)
      x += delta[0]
      y += delta[1]
      return [x, y]
    })
  })
}

/** 弧を経緯度に戻して投影した点の列にする */
const decodeArcs = (arcs: unknown, scale: Point, translate: Point): Point[][] =>
  quantizedArcsOf(arcs).map((arc) =>
    arc.map(([x, y]): Point => {
      const lon = x * scale[0] + translate[0]
      const lat = y * scale[1] + translate[1]
      return [lon * LON_SCALE, -lat]
    }),
  )

/** 弧の番号の列をつないで輪にする。負の番号（~i）は弧 i を逆向きにたどる */
const ringOf = (arcIndexes: unknown, arcs: readonly Point[][]): Ring => {
  if (!isNumberList(arcIndexes)) throw new Error('日本地図の輪が、弧の番号の列ではありません')
  return arcIndexes.flatMap((index) => {
    const arc = arcs[index < 0 ? ~index : index]
    if (arc === undefined) throw new Error(`日本地図に無い弧の番号を指しています: ${index}`)
    return index < 0 ? [...arc].reverse() : arc
  })
}

/** 形（Polygon・MultiPolygon）を、多角形ごとの輪（弧の番号の列）の列にする。各多角形の最初の輪が外周、残りが穴 */
const polygonsOf = (geometry: Record<string, unknown>): unknown[][] => {
  const polygonOf = (rings: unknown): unknown[] => {
    if (!Array.isArray(rings)) throw new Error('日本地図の多角形が、輪の列ではありません')
    return rings
  }
  if (geometry.type === 'Polygon') return [polygonOf(geometry.arcs)]
  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.arcs)) return geometry.arcs.map((polygon: unknown) => polygonOf(polygon))
  throw new Error(`日本地図に、多角形でない形があります: ${String(geometry.type)}`)
}

/** 形（Polygon・MultiPolygon）を輪の列にする */
const ringsOf = (geometry: Record<string, unknown>, arcs: readonly Point[][]): Ring[] =>
  polygonsOf(geometry).flatMap((rings) => rings.map((ring) => ringOf(ring, arcs)))

/** 市町村の形1つ。コードと、TopoJSON の形（Polygon・MultiPolygon）そのもの */
interface TownGeometry {
  readonly code: string
  readonly geometry: Record<string, unknown>
}

/**
 * 日本地図が量子化した TopoJSON であることを確かめ、transform と市町村の形の一覧を取り出す。
 *
 * @throws 想定した形（objects.towns の GeometryCollection、各形が properties.code を持つ）でない場合
 */
const readTopology = (topology: unknown): { scale: Point; translate: Point; arcs: unknown; towns: TownGeometry[] } => {
  if (!isRecord(topology) || !isRecord(topology.transform)) throw new Error('日本地図が、量子化した TopoJSON ではありません')
  const { scale, translate } = topology.transform
  if (!isPair(scale) || !isPair(translate)) throw new Error('日本地図の transform が数の組ではありません')
  const towns = isRecord(topology.objects) ? topology.objects.towns : undefined
  if (!isRecord(towns) || !Array.isArray(towns.geometries)) throw new Error('日本地図に、市町村の形の一覧（objects.towns）がありません')
  return {
    scale,
    translate,
    arcs: topology.arcs,
    towns: towns.geometries.map((geometry: unknown, index) => {
      const code = isRecord(geometry) && isRecord(geometry.properties) ? geometry.properties.code : undefined
      if (!isRecord(geometry) || typeof code !== 'string') throw new Error(`日本地図の形 ${index} に、市町村のコードがありません`)
      return { code, geometry }
    }),
  }
}

/**
 * 同梱の日本地図を、市町村のコードごとの輪の列にする。
 *
 * @throws 想定した形（objects.towns の GeometryCollection、各形が properties.code を持つ）でない場合
 */
export const decodeTownShapes = (topology: unknown): ReadonlyMap<string, readonly Ring[]> => {
  const { scale, translate, arcs, towns } = readTopology(topology)
  const decoded = decodeArcs(arcs, scale, translate)
  return new Map(towns.map(({ code, geometry }): [string, Ring[]] => [code, ringsOf(geometry, decoded)]))
}

/** 市町村の境界の分け合い方（都道府県当てクイズのヒントの材料） */
export interface TownBorders {
  /** 海に面している市町村のコード */
  readonly coastal: ReadonlySet<string>
  /** 市町村のコードごとの、境界を分け合う（隣り合う）市町村のコード */
  readonly adjacent: ReadonlyMap<string, ReadonlySet<string>>
}

/** 点の列が囲む面積（符号付き。向きによって符号が変わる） */
const signedAreaOf = (points: readonly Point[]): number =>
  points.reduce((sum, [x1, y1], index) => {
    const next = points[(index + 1) % points.length]
    if (next === undefined) throw new Error('面積を求める点の列が途中で欠けています')
    const [x2, y2] = next
    return sum + x1 * y2 - x2 * y1
  }, 0) / 2

/** 弧の番号（負なら ~i）の向きのままの点の列 */
const directedPointsOf = (index: number, arcs: readonly Point[][]): readonly Point[] => {
  const arc = arcs[index < 0 ? ~index : index]
  if (arc === undefined) throw new Error(`日本地図に無い弧の番号を指しています: ${index}`)
  return index < 0 ? [...arc].reverse() : arc
}

/** 点を、つなぎ目を探すためのキーにする（量子化した座標は整数なので、そのまま文字列にしてよい） */
const pointKeyOf = ([x, y]: Point): string => `${x},${y}`

/**
 * 向き付きの弧の、始点か終点のキー
 *
 * @throws 点を1つも持たない弧の場合
 */
const endKeyOf = (index: number, arcs: readonly Point[][], end: 'start' | 'end'): string => {
  const arc = arcs[index < 0 ? ~index : index]
  if (arc === undefined) throw new Error(`日本地図に無い弧の番号を指しています: ${index}`)
  // 負の番号は逆向きにたどるので、始点と終点が入れ替わる（弧を複製して逆順にはしない）
  const point = (end === 'start') === index >= 0 ? arc[0] : arc.at(-1)
  if (point === undefined) throw new Error(`日本地図に、点を持たない弧があります: ${index}`)
  return pointKeyOf(point)
}

/**
 * 分け合わない弧（向き付き）を、終点と始点が重なるものどうしでつないで輪にする。
 *
 * 1つの点から次の弧が2本以上出ている（海岸と穴の縁が1点で接する）ときは、先に見つかったほうへ進む。
 */
const chainRings = (directed: readonly number[], arcs: readonly Point[][]): number[][] => {
  const byStart = new Map<string, number[]>()
  for (const index of directed) {
    const key = endKeyOf(index, arcs, 'start')
    byStart.set(key, [...(byStart.get(key) ?? []), index])
  }
  const used = new Set<number>()
  const rings: number[][] = []
  for (const first of directed) {
    if (used.has(first)) continue
    const ring: number[] = []
    let current: number | undefined = first
    while (current !== undefined) {
      used.add(current)
      ring.push(current)
      const endKey: string = endKeyOf(current, arcs, 'end')
      current = byStart.get(endKey)?.find((next) => !used.has(next))
    }
    rings.push(ring)
  }
  return rings
}

/**
 * 同梱の日本地図から、海に面している市町村と、隣り合う市町村を求める。
 *
 * @throws 想定した形（objects.towns の GeometryCollection、各形が properties.code を持つ）でない場合
 */
export const decodeTownBorders = (topology: unknown): TownBorders => {
  const { arcs, towns } = readTopology(topology)
  const quantized = quantizedArcsOf(arcs)

  // 弧ごとに、その弧を使う市町村と、その市町村がたどる向き（弧の番号の符号）を集める
  const users = new Map<number, { code: string; index: number }[]>()
  /** 外周の輪の面積の合計。符号が、市町村が外周をたどる向きを表す */
  let exteriorArea = 0
  for (const { code, geometry } of towns) {
    for (const [exterior, ...holes] of polygonsOf(geometry)) {
      exteriorArea += signedAreaOf(ringOf(exterior, quantized))
      for (const ring of [exterior, ...holes]) {
        if (!isNumberList(ring)) throw new Error('日本地図の輪が、弧の番号の列ではありません')
        for (const index of ring) {
          const arc = index < 0 ? ~index : index
          users.set(arc, [...(users.get(arc) ?? []), { code, index }])
        }
      }
    }
  }

  const adjacent = new Map<string, Set<string>>(towns.map(({ code }) => [code, new Set<string>()]))
  const borderArcs: { code: string; index: number }[] = []
  for (const arcUsers of users.values()) {
    const [only] = arcUsers
    if (arcUsers.length === 1 && only !== undefined) borderArcs.push(only)
    for (const { code } of arcUsers) {
      for (const other of arcUsers) if (other.code !== code) adjacent.get(code)?.add(other.code)
    }
  }

  // 縁の弧を輪につなぎ、外周と同じ向きの輪（海岸線）に使われた弧の持ち主を、海に面しているとする
  const ownerOf = new Map(borderArcs.map(({ code, index }) => [index, code]))
  const coastal = new Set<string>()
  for (const ring of chainRings(borderArcs.map(({ index }) => index), quantized)) {
    const area = signedAreaOf(ring.flatMap((index) => directedPointsOf(index, quantized)))
    if (Math.sign(area) !== Math.sign(exteriorArea)) continue
    for (const index of ring) {
      const code = ownerOf.get(index)
      if (code !== undefined) coastal.add(code)
    }
  }
  return { coastal, adjacent }
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
