/**
 * ツイスターのスピナー（手足と色を指す回る針）
 *
 * 盤は手足ごとに4つに分かれ（LIMBS の順）、それぞれが4色に分かれる（MAT_COLORS の順）。全部で16区画。
 * 角度は盤の真上を 0 とし、時計回りに増える（ラジアン）。
 * 針は勢いよく回ってから減速し、指示の手足と色の区画の真ん中で止まる。角度は回しはじめからの経過時間と、針が回る長さだけから決まる。
 * 針が回る長さは手番ごとに違う（はじめの手番はゆっくり、後半は速い。game.ts の paceOf）ので、呼び出し側が渡す。
 * スピナーは、針を回して結果を見せるあいだだけ大きく出し、手足を運ぶ場面では人形が見えるように小さく戻す（spinnerZoomAt）。
 */
import { LIMBS, type Limb } from './body'
import { MAT_COLORS, type MatColor } from './mat'
import { easeInOut } from './path'

/** 止まるまでに回る回数 */
const SPIN_TURNS = 3
const FULL_TURN = Math.PI * 2
/** 回しはじめに、小さいスピナーが大きくなりきるまでの長さ（ミリ秒）。針が止まるより前に大きくなり終える */
export const SPINNER_GROW_MS = 300
/** 手足を運ぶ場面に入ってから、大きいスピナーが小さく戻りきるまでの長さ（ミリ秒） */
export const SPINNER_SHRINK_MS = 500
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

/**
 * 回しはじめから elapsedMs 後の針の角度。減速しながら進み、turnMs で止まる。
 *
 * @param turnMs 針が回っている長さ（ミリ秒）。これを過ぎたら止まっている。短いほど同じ回数を速く回る
 */
export const spinnerAngleAt = (pick: SpinnerPick, elapsedMs: number, turnMs: number): number => {
  const progress = Math.min(Math.max(elapsedMs / turnMs, 0), 1)
  const eased = 1 - (1 - progress) ** 3
  return spinnerTargetAngle(pick.limb, pick.color) - SPIN_TURNS * FULL_TURN * (1 - eased)
}

/**
 * 回しはじめから elapsedMs 後の、スピナーの大きさの度合い（0: 小さい、1: 大きい）。
 * 回しはじめに SPINNER_GROW_MS かけて大きくなり、結果を見せ終える（spinMs）まで大きいまま、そこから SPINNER_SHRINK_MS かけて小さく戻る。
 * 大きさと置き場所をこの度合いでどう変えるかは描画（view.ts）が決める。
 *
 * @param spinMs スピナーを回して結果を見せる長さ（ミリ秒。game.ts の TurnPace.spinMs）。これを過ぎると手足を運ぶ場面になる
 */
export const spinnerZoomAt = (elapsedMs: number, spinMs: number): number => {
  const grown = Math.min(Math.max(elapsedMs / SPINNER_GROW_MS, 0), 1)
  const shrunk = Math.min(Math.max((elapsedMs - spinMs) / SPINNER_SHRINK_MS, 0), 1)
  return easeInOut(grown) * (1 - easeInOut(shrunk))
}
