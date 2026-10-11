/**
 * 舌の形（表面の1点の位置）
 *
 * 舌は、長さの向きの位置 u（0: 根元、1: 舌先）と幅の向きの位置 v（-1: 左端、1: 右端）で表面を張った、平たく厚みのある板として作る。
 * 舌先を原点に置き、根元は y の負の側、表（乳頭のある側）は z の正の側（カメラ）を向く。描画（view.ts）は毎コマこれで頂点を動かす。
 *
 * - なかほどがいちばん広く、舌先は丸く細まる。表の真ん中には溝が通る
 * - 押しつぶれ（squash）は、アイコンに押し当てた舌先のあたりを平たく広げる（根元は変えない）
 * - 丸め（curl）は、舌先のあたりを手前（カメラの側）へ巻き上げ、アイコンをすくう形にする（根元は動かさない）
 *
 * 注意: DOM も three.js も読み込まない（形だけを計算する）。
 */

/** その時刻の舌の様子 */
export interface TonguePose {
  /** 根元から舌先までの長さ（3Dの単位） */
  readonly length: number
  /** 舌先が押しつぶれて平たく広がる度合い（0〜1） */
  readonly squash: number
  /** 舌先を丸めて巻き上げる度合い（0〜1） */
  readonly curl: number
}

/** 表面の1点（舌先を原点にした3Dの位置） */
export interface SurfacePoint {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** いちばん広いところの半分の幅（3Dの単位） */
const HALF_WIDTH = 0.34
/** いちばん広い位置（u） */
const WIDEST_AT = 0.75
/** 根元の幅の割合（いちばん広いところに対して） */
const ROOT_WIDTH = 0.8
/** 厚みの半分（3Dの単位）と、舌先へ向かって薄くなる割合 */
const HALF_THICKNESS = 0.075
const TIP_THINNING = 0.45
/** 表の真ん中の溝の深さ（3Dの単位）と幅（v の単位） */
const GROOVE_DEPTH = 0.035
const GROOVE_WIDTH = 0.28
/** 押しつぶれたときに、幅を広げる割合と厚みを減らす割合 */
const SQUASH_WIDEN = 0.6
const SQUASH_FLATTEN = 0.7
/** 押しつぶれ・丸めが効きはじめる位置（u） */
const SQUASH_FROM = 0.6
const CURL_FROM = 0.7
/** 丸めきったときの舌先の曲がり（ラジアン）。直角を越えて巻き込み、裏側（血管）をカメラに見せる */
const CURL_MAX = 2.6
/** 丸めた中心線を積み上げる刻みの数（多いほどなめらか） */
const CURL_STEPS = 24

/** 0〜1 に収める */
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/** 始まりと終わりをなめらかにする（0〜1 → 0〜1） */
const smooth = (t: number): number => t * t * (3 - 2 * t)

/** 位置 u の半分の幅（押しつぶれる前） */
const halfWidthAt = (u: number): number => {
  if (u <= WIDEST_AT) return HALF_WIDTH * (ROOT_WIDTH + (1 - ROOT_WIDTH) * smooth(u / WIDEST_AT))
  // 舌先は円の弧のように丸く細める
  const t = (u - WIDEST_AT) / (1 - WIDEST_AT)
  return HALF_WIDTH * Math.sqrt(Math.max(0, 1 - t * t))
}

/** 位置 u での曲がり（ラジアン）。丸めていなければ 0 */
const bendAt = (u: number, curl: number): number => curl * CURL_MAX * clamp01((u - CURL_FROM) / (1 - CURL_FROM)) ** 2

/**
 * 中心線の位置 u の点と、そこでの曲がりを求める。
 * 曲がらないとき舌先が原点に来るよう、根元を (0, -length) に置いて、u までの曲がりを刻んで積み上げる。
 */
const centerlineAt = (u: number, pose: TonguePose): { readonly y: number; readonly z: number; readonly angle: number } => {
  let y = -pose.length
  let z = 0
  const step = u / CURL_STEPS
  for (let index = 0; index < CURL_STEPS; index += 1) {
    // 刻みの真ん中の曲がりで進める（前へ: y の正、手前へ曲がると z の正へ）
    const angle = bendAt((index + 0.5) * step, pose.curl)
    y += Math.cos(angle) * step * pose.length
    z += Math.sin(angle) * step * pose.length
  }
  return { y, z, angle: bendAt(u, pose.curl) }
}

/**
 * 舌の表面の1点の位置を求める。
 *
 * @param u 長さの向きの位置（0: 根元、1: 舌先）
 * @param v 幅の向きの位置（-1: 左端、1: 右端）
 * @param side 表（乳頭と溝のある側。手前を向く）か裏（血管のある側）か
 */
export const tongueSurfacePoint = (u: number, v: number, side: 'top' | 'bottom', pose: TonguePose): SurfacePoint => {
  const across = Math.sqrt(Math.max(0, 1 - v * v))
  const squash = pose.squash * smooth(clamp01((u - SQUASH_FROM) / (1 - SQUASH_FROM)))
  const halfWidth = halfWidthAt(u) * (1 + SQUASH_WIDEN * squash)
  const thickness = HALF_THICKNESS * (1 - TIP_THINNING * u) * across * (1 - SQUASH_FLATTEN * squash)
  // 溝は根元と舌先の近くでは浅くし、なかほどで深くする
  const groove = side === 'top' ? GROOVE_DEPTH * Math.exp(-((v / GROOVE_WIDTH) ** 2)) * Math.sin(Math.PI * u) * (1 - SQUASH_FLATTEN * squash) : 0
  const offset = side === 'top' ? thickness - groove : -thickness
  const center = centerlineAt(u, pose)
  // 厚みの向き（表の法線）は、中心線の曲がりに合わせて回す
  return { x: v * halfWidth, y: center.y - Math.sin(center.angle) * offset, z: center.z + Math.cos(center.angle) * offset }
}
