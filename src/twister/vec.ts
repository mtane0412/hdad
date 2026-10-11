/**
 * ツイスターの3次元の位置の計算（three.js に頼らない小さなベクトルの道具）
 *
 * 姿勢・物理・計画はテストで確かめる純粋な計算なので、描画の three.js を読み込まずに済むようここで持つ。
 * 座標はメートルで、y が上、マットは y = 0 の面に置く。
 */

/** 3次元の位置・向き */
export interface Vec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** 真上の向き */
export const UP: Vec3 = { x: 0, y: 1, z: 0 }

export const vec = (x: number, y: number, z: number): Vec3 => ({ x, y, z })
export const add = (a: Vec3, b: Vec3): Vec3 => vec(a.x + b.x, a.y + b.y, a.z + b.z)
export const sub = (a: Vec3, b: Vec3): Vec3 => vec(a.x - b.x, a.y - b.y, a.z - b.z)
export const scale = (a: Vec3, factor: number): Vec3 => vec(a.x * factor, a.y * factor, a.z * factor)
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
export const cross = (a: Vec3, b: Vec3): Vec3 => vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)
export const length = (a: Vec3): number => Math.sqrt(dot(a, a))
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b))
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, scale(sub(b, a), t))
export const midpoint = (a: Vec3, b: Vec3): Vec3 => lerp(a, b, 0.5)
/** 床に落とした位置（高さを 0 にする） */
export const flat = (a: Vec3): Vec3 => vec(a.x, 0, a.z)

/** 長さが 0 に近いと向きが決まらないので、そのときは代わりの向きを返す */
export const normalize = (a: Vec3, fallback: Vec3): Vec3 => {
  const size = length(a)
  return size < 1e-9 ? fallback : scale(a, 1 / size)
}

/** 線分 a→b の上で、点 p にもっとも近い位置の割合（0〜1） */
export const closestRatioOnSegment = (p: Vec3, a: Vec3, b: Vec3): number => {
  const ab = sub(b, a)
  const squared = dot(ab, ab)
  if (squared < 1e-12) return 0
  return Math.min(1, Math.max(0, dot(sub(p, a), ab) / squared))
}

/** 点 p から線分 a→b までの距離 */
export const distanceToSegment = (p: Vec3, a: Vec3, b: Vec3): number => distance(p, lerp(a, b, closestRatioOnSegment(p, a, b)))

/** 上から見た、o→a と o→b の外積（左回りなら正） */
const turnFlat = (o: Vec3, a: Vec3, b: Vec3): number => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x)

/**
 * 上から見て（高さを無視して）、線分 a1→a2 と b1→b2 が交差するか。
 * 端が相手の線分の上に乗っているだけ・端どうしが触れているだけのときは交差とみなさない。
 */
export const segmentsCrossFlat = (a1: Vec3, a2: Vec3, b1: Vec3, b2: Vec3): boolean =>
  turnFlat(a1, a2, b1) * turnFlat(a1, a2, b2) < 0 && turnFlat(b1, b2, a1) * turnFlat(b1, b2, a2) < 0

/** 上から見て（高さを無視して）、線分 a1→a2 と b1→b2 のあいだのいちばん近い距離。交差していれば 0 */
export const segmentDistanceFlat = (a1: Vec3, a2: Vec3, b1: Vec3, b2: Vec3): number => {
  const [fa1, fa2, fb1, fb2] = [flat(a1), flat(a2), flat(b1), flat(b2)]
  if (segmentsCrossFlat(fa1, fa2, fb1, fb2)) return 0
  // 交差しない2本のいちばん近い位置は、どちらかの端にある
  return Math.min(distanceToSegment(fa1, fb1, fb2), distanceToSegment(fa2, fb1, fb2), distanceToSegment(fb1, fa1, fa2), distanceToSegment(fb2, fa1, fa2))
}

/**
 * 線分 a1→a2 と b1→b2 のあいだのいちばん近い距離（3次元）。
 * 2本の上でいちばん近い位置の割合を、片方を固定して求め、もう片方を範囲に収めてから求め直す（よく使われる求め方）
 */
export const segmentDistance = (a1: Vec3, a2: Vec3, b1: Vec3, b2: Vec3): number => {
  const d1 = sub(a2, a1)
  const d2 = sub(b2, b1)
  const r = sub(a1, b1)
  const a = dot(d1, d1)
  const e = dot(d2, d2)
  const f = dot(d2, r)
  if (a < 1e-12 && e < 1e-12) return length(r)
  if (a < 1e-12) return distanceToSegment(a1, b1, b2)
  if (e < 1e-12) return distanceToSegment(b1, a1, a2)
  const c = dot(d1, r)
  const b = dot(d1, d2)
  const denominator = a * e - b * b
  const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1)
  // 平行なときは、片方の端から始める
  let s = denominator > 1e-12 ? clamp01((b * f - c * e) / denominator) : 0
  let t = (b * s + f) / e
  if (t < 0) {
    t = 0
    s = clamp01(-c / a)
  } else if (t > 1) {
    t = 1
    s = clamp01((b - c) / a)
  }
  return distance(add(a1, scale(d1, s)), add(b1, scale(d2, t)))
}
