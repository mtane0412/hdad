/**
 * ツイスターのマット（色の円の並び）
 *
 * 本物と同じく、4色の列に円が6つずつ並ぶ。列は x 方向（赤・黄・緑・青の順）、行は z 方向に並べる。
 * 円の間隔は本物より広くしてある。人形の寸法（body.ts）で四つんばいになった2人が、両端から向かい合って収まるようにするためである。
 */
import { vec, type Vec3 } from './vec'

/** マットの色（列の並び順） */
export const MAT_COLORS = ['red', 'yellow', 'green', 'blue'] as const
export type MatColor = (typeof MAT_COLORS)[number]

/** 色の、画面に出す名前（スピナーの区画） */
export const COLOR_LABELS: Readonly<Record<MatColor, string>> = {
  red: '赤',
  yellow: '黄',
  green: '緑',
  blue: '青',
}

/** 色の、描くときの色 */
export const COLOR_HEX: Readonly<Record<MatColor, string>> = {
  red: '#e53935',
  yellow: '#fdd835',
  green: '#43a047',
  blue: '#1e88e5',
}

/** 1色あたりの円の数（行の数） */
export const MAT_ROWS = 6
/** 列の間隔・行の間隔（m） */
export const COLUMN_SPACING = 0.4
export const ROW_SPACING = 0.45
/** 円の半径（m） */
export const SPOT_RADIUS = 0.15
/** マットそのものの大きさ（m）。円の並びの外に余白を取る */
export const MAT_WIDTH = COLUMN_SPACING * MAT_COLORS.length + 0.2
export const MAT_DEPTH = ROW_SPACING * MAT_ROWS + 0.2

/** マットの円1つ（色と、その色の中で何行目か） */
export interface Spot {
  readonly color: MatColor
  readonly row: number
}

/** 円の中心の位置（マットの中心が原点） */
export const spotPosition = (spot: Spot): Vec3 =>
  vec((MAT_COLORS.indexOf(spot.color) - (MAT_COLORS.length - 1) / 2) * COLUMN_SPACING, 0, (spot.row - (MAT_ROWS - 1) / 2) * ROW_SPACING)

export const sameSpot = (a: Spot, b: Spot): boolean => a.color === b.color && a.row === b.row

/** マットのすべての円（色の順、行の順） */
export const ALL_SPOTS: readonly Spot[] = MAT_COLORS.flatMap((color) => Array.from({ length: MAT_ROWS }, (_, row) => ({ color, row })))
