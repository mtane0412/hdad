/**
 * ツイスターの2人（レイドした人と配信者）の並び
 *
 * 0番がレイドした人、1番が配信者。手番はレイドした人から交互に回る。
 * 2人はマットの両端（z の負の端と正の端）から、四つんばいで向かい合って始める。
 */
import type { Limb } from './body'
import type { Spot } from './mat'
import { vec, type Vec3 } from './vec'

/** 2人の番号（0: レイドした人、1: 配信者） */
export type PlayerIndex = 0 | 1
export const PLAYER_INDEXES: readonly PlayerIndex[] = [0, 1]

/** 相手の番号 */
export const opponentOf = (player: PlayerIndex): PlayerIndex => (player === 0 ? 1 : 0)

/** 2人が始めに向いている向き（足から手へ）。手を足の真上に寄せられて向きが決まらないときの目安にも使う */
export const PLAYER_FACINGS: readonly [Vec3, Vec3] = [vec(0, 0, 1), vec(0, 0, -1)]

/** 手足ごとの置き場所 */
export type Placement = Readonly<Record<Limb, Spot>>

/**
 * 始めの置き場所。足を自分の側の端の行に、手を真ん中寄りの行に置く。
 * 右は前向きと上向きの外積の側なので、+z を向くレイドした人は右が x の負の側（黄）、-z を向く配信者は右が x の正の側（緑）になる。
 */
export const INITIAL_SPOTS: readonly [Placement, Placement] = [
  {
    footR: { color: 'yellow', row: 0 },
    footL: { color: 'green', row: 0 },
    handR: { color: 'yellow', row: 2 },
    handL: { color: 'green', row: 2 },
  },
  {
    footR: { color: 'green', row: 5 },
    footL: { color: 'yellow', row: 5 },
    handR: { color: 'green', row: 3 },
    handL: { color: 'yellow', row: 3 },
  },
]
