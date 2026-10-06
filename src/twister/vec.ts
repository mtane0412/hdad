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
