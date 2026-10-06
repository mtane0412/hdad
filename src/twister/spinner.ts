/**
 * ツイスターのスピナー（手足と色を指す回る針）
 *
 * 盤は手足ごとに4つに分かれ（LIMBS の順）、それぞれが4色に分かれる（MAT_COLORS の順）。全部で16区画。
 * 角度は盤の真上を 0 とし、時計回りに増える（ラジアン）。
 * 針は勢いよく回ってから減速し、指示の手足と色の区画の真ん中で止まる。角度は回しはじめからの経過時間だけから決まる。
 */
import { LIMBS, type Limb } from './body'
import { MAT_COLORS, type MatColor } from './mat'

/** 針が回っている長さ（ミリ秒）。これを過ぎたら止まっている */
export const SPIN_TURN_MS = 1800
/** 止まるまでに回る回数 */
const SPIN_TURNS = 3
const FULL_TURN = Math.PI * 2
/** 区画の数と、1区画の角度 */
export const SPINNER_SEGMENTS = LIMBS.length * MAT_COLORS.length
export const SEGMENT_ANGLE = FULL_TURN / SPINNER_SEGMENTS

/** スピナーが指すもの（手足と色） */
export interface SpinnerPick {
  readonly limb: Limb
  readonly color: MatColor
}

/** 区画の並びでの位置（手足ごとにまとめ、その中を色の順に並べる） */
export const segmentIndexOf = (limb: Limb, color: MatColor): number => LIMBS.indexOf(limb) * MAT_COLORS.length + MAT_COLORS.indexOf(color)

/** 手足と色の区画の真ん中の角度 */
export const spinnerTargetAngle = (limb: Limb, color: MatColor): number => (segmentIndexOf(limb, color) + 0.5) * SEGMENT_ANGLE

/** 角度が指している区画 */
export const spinnerSegmentAt = (angle: number): SpinnerPick => {
  const normalized = ((angle % FULL_TURN) + FULL_TURN) % FULL_TURN
  const index = Math.floor(normalized / SEGMENT_ANGLE)
  const limb = LIMBS[Math.floor(index / MAT_COLORS.length)]
  const color = MAT_COLORS[index % MAT_COLORS.length]
  if (limb === undefined || color === undefined) throw new Error(`スピナーの区画 ${index} がありません`)
  return { limb, color }
}

/** 回しはじめから elapsedMs 後の針の角度。減速しながら進み、SPIN_TURN_MS で止まる */
export const spinnerAngleAt = (pick: SpinnerPick, elapsedMs: number): number => {
  const progress = Math.min(Math.max(elapsedMs / SPIN_TURN_MS, 0), 1)
  const eased = 1 - (1 - progress) ** 3
  return spinnerTargetAngle(pick.limb, pick.color) - SPIN_TURNS * FULL_TURN * (1 - eased)
}
