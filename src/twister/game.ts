/**
 * ツイスターの1回の対戦の進み方
 *
 * 対戦は種（seed）だけから決まる。createGame が指示の並び（plan.ts）を決め、倒れ込み（physics.ts）を先に計算して記録する。
 * 場面と2人の姿勢は、再生を始めてからの経過時間だけから決まる（gameSceneAt。フレーム間の状態を持たない）。
 *
 * 流れ:
 * 1. 登場（INTRO_MS）: 2人が四つんばいで向かい合う
 * 2. 絡ませる指示を2回か3回: スピナーを回し（SPIN_MS）、指された手足を弧を描いて指された円へ運ぶ（MOVE_MS）
 * 3. 最後の指示: スピナーを回し（SPIN_MS）、届かない円へ手足を伸ばし（REACH_MS）、倒れ込む（記録をスローモーションで再生する）
 * 4. 結果（RESULT_MS）: 先にマットに着いた人の負けとして、勝者を出す
 *
 * 倒れ込むまでの姿勢は、その時刻の手足の位置から IK で解き（pose.ts）、2人の体のめり込みを押し出して求める（relaxPoses）。
 * 倒れ込みの計算は、この求め方で出した倒れはじめの姿勢から始めるので、場面の切り替わりで姿勢が飛ばない。
 */
import { createRandom } from '../core/background'
import { LIMB_CHAINS, type Joint, type Limb, type Pose } from './body'
import { placementsAfter, planGame, type Move, type Plan } from './plan'
import { COLLAPSE_FRAME_MS, PHYSICS_STEP_MS, bakeCollapse, collapsePosesAt, relaxPoses, type Collapse, type Pins, type PosePair, type Touchdown } from './physics'
import { PLAYER_FACINGS, opponentOf, type PlayerIndex } from './players'
import { contactsOf, restingOn, solvePose, type Contacts } from './pose'
import { UP, add, flat, lerp, normalize, scale, sub, type Vec3 } from './vec'

/** 登場の長さ（ミリ秒） */
export const INTRO_MS = 3000
/** スピナーを回して結果を見せる長さ（ミリ秒）。針が止まってから（spinner.ts の SPIN_TURN_MS の後）結果を読む間を含む */
export const SPIN_MS = 2600
/** 指された手足を運ぶ長さ（ミリ秒） */
export const MOVE_MS = 1400
/** 最後の指示で、届かない円へ手足を伸ばす長さ（ミリ秒） */
export const REACH_MS = 900
/**
 * 倒れ込みを再生する速さ（物理の時間に対する割合）。倒れ込みは物理の時間では1秒足らずで終わり、配信の画面では何が起きたか追えないので、
 * スローモーションで見せる
 */
export const COLLAPSE_PLAYBACK_RATE = 0.4
/** 勝者を出す長さ（ミリ秒） */
export const RESULT_MS = 5500
/** 手足を運ぶときに持ち上げる高さ（m） */
const MOVE_ARC_HEIGHT = 0.25
/** 最後の指示で手足を伸ばすときに持ち上げる高さ（m） */
const REACH_ARC_HEIGHT = 0.15

/** 1回の対戦（種から決まり、再生のあいだ変わらない） */
export interface Game {
  readonly seed: number
  readonly plan: Plan
  /** 先に計算した倒れ込み */
  readonly collapse: Collapse
  /** 倒れはじめる時刻（再生を始めてからのミリ秒） */
  readonly collapseStartMs: number
  /** 先にマットに着いた人と部位と時刻 */
  readonly touchdown: Touchdown
  /** 再生の長さ（ミリ秒） */
  readonly totalMs: number
}

export type GamePhase = 'intro' | 'spin' | 'move' | 'reach' | 'collapse' | 'result'

/** スピナーに出すもの */
export interface SpinState {
  readonly move: Move
  /** 何回目の指示か（0から） */
  readonly index: number
  /** 倒れ込ませる最後の指示か */
  readonly final: boolean
  /** スピナーを回しはじめてからのミリ秒 */
  readonly elapsedMs: number
}

/** 勝敗 */
export interface GameResult {
  readonly loser: PlayerIndex
  readonly winner: PlayerIndex
  /** 負けた人の、先にマットに着いた部位 */
  readonly joint: Joint
}

/** ある時刻の場面 */
export interface GameScene {
  readonly phase: GamePhase
  readonly poses: PosePair
  /** スピナーを出す場面（回す・運ぶ・伸ばす）なら、その指示。ほかは null */
  readonly spin: SpinState | null
  /** 結果の場面なら勝敗。ほかは null */
  readonly result: GameResult | null
  /** 再生を終えたか */
  readonly done: boolean
}

/** ゆっくり動きだし、ゆっくり止まる（0〜1 → 0〜1） */
const easeInOut = (progress: number): number => (progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2)

const clampProgress = (elapsedMs: number, spanMs: number): number => Math.min(Math.max(elapsedMs / spanMs, 0), 1)

/** 手足を from から to へ、弧を描いて運ぶ途中の位置 */
const arcBetween = (from: Vec3, to: Vec3, progress: number, height: number): Vec3 => {
  const eased = easeInOut(progress)
  return add(lerp(from, to, eased), scale(UP, height * Math.sin(Math.PI * eased)))
}

/** i 回目（0から）の絡ませる指示のスピナーを回しはじめる時刻 */
const spinStartOf = (index: number): number => INTRO_MS + index * (SPIN_MS + MOVE_MS)

/** 手足を動かしている途中の1本（動かしていなければ null） */
interface Motion {
  readonly player: PlayerIndex
  readonly limb: Limb
  readonly position: Vec3
}

/** 倒れ込むまでの時刻の、終えた指示と動かしている途中の手足 */
const motionAt = (plan: Plan, elapsedMs: number): { done: readonly Move[]; motion: Motion | null } => {
  const { moves, finalMove } = plan
  const doneCount = moves.filter((_, index) => elapsedMs >= spinStartOf(index) + SPIN_MS + MOVE_MS).length
  const done = moves.slice(0, doneCount)
  const before = placementsAfter(done)
  const moving = moves[doneCount]
  if (moving !== undefined) {
    const moveStart = spinStartOf(doneCount) + SPIN_MS
    if (elapsedMs < moveStart) return { done, motion: null }
    const from = restingOn(before[moving.player][moving.limb], moving.limb)
    const to = restingOn(moving.spot, moving.limb)
    return { done, motion: { player: moving.player, limb: moving.limb, position: arcBetween(from, to, clampProgress(elapsedMs - moveStart, MOVE_MS), MOVE_ARC_HEIGHT) } }
  }
  // 絡ませる指示を終えたら、最後の指示で届かない円へ手足を伸ばす
  const reachStart = spinStartOf(moves.length) + SPIN_MS
  if (elapsedMs < reachStart) return { done, motion: null }
  const from = restingOn(before[finalMove.player][finalMove.limb], finalMove.limb)
  const to = restingOn(finalMove.spot, finalMove.limb)
  return { done, motion: { player: finalMove.player, limb: finalMove.limb, position: arcBetween(from, to, clampProgress(elapsedMs - reachStart, REACH_MS), REACH_ARC_HEIGHT) } }
}

/** 姿勢の手足の先を、そのまま留める位置にする（めり込みを押し出すときに手足を動かさない） */
const pinsOf = (pose: Pose): Pins => ({ handL: pose.handL, handR: pose.handR, footL: pose.footL, footR: pose.footR })

/** 倒れ込むまでの時刻の、2人の姿勢 */
const standingPosesAt = (plan: Plan, elapsedMs: number): PosePair => {
  const { done, motion } = motionAt(plan, elapsedMs)
  const placements = placementsAfter(done)
  const contactsFor = (player: PlayerIndex): Contacts => {
    const contacts = contactsOf(placements[player])
    return motion !== null && motion.player === player ? { ...contacts, [motion.limb]: motion.position } : contacts
  }
  const raider = solvePose(contactsFor(0), PLAYER_FACINGS[0])
  const streamer = solvePose(contactsFor(1), PLAYER_FACINGS[1])
  return relaxPoses([raider, streamer], [pinsOf(raider), pinsOf(streamer)])
}

/**
 * 種から1回の対戦を作る（指示を決め、倒れ込みを先に計算する）。
 *
 * @throws 指示を決められない・誰もマットに着かない場合（どちらも計算の誤り）
 */
export const createGame = (seed: number): Game => {
  const plan = planGame(createRandom(seed))
  const collapseStartMs = spinStartOf(plan.moves.length) + SPIN_MS + REACH_MS
  const poses = standingPosesAt(plan, collapseStartMs)
  const previous = standingPosesAt(plan, collapseStartMs - PHYSICS_STEP_MS)
  const { player, limb, spot } = plan.finalMove
  // 倒れる人は、伸ばした手足の付け根から指された円の向きへ倒れる
  const push = normalize(flat(sub(restingOn(spot, limb), poses[player][LIMB_CHAINS[limb].root])), PLAYER_FACINGS[player])
  const collapse = bakeCollapse({ poses, previous, pins: [pinsOf(poses[0]), pinsOf(poses[1])], faller: player, push })
  const collapseMs = ((collapse.frames.length - 1) * COLLAPSE_FRAME_MS) / COLLAPSE_PLAYBACK_RATE
  return { seed, plan, collapse, collapseStartMs, touchdown: collapse.touchdown, totalMs: collapseStartMs + collapseMs + RESULT_MS }
}

/** スピナーを出す場面なら、その指示 */
const spinAt = (game: Game, elapsedMs: number): SpinState | null => {
  const { moves, finalMove } = game.plan
  for (const [index, move] of moves.entries()) {
    const start = spinStartOf(index)
    if (elapsedMs >= start && elapsedMs < start + SPIN_MS + MOVE_MS) return { move, index, final: false, elapsedMs: elapsedMs - start }
  }
  const finalStart = spinStartOf(moves.length)
  if (elapsedMs >= finalStart && elapsedMs < game.collapseStartMs) return { move: finalMove, index: moves.length, final: true, elapsedMs: elapsedMs - finalStart }
  return null
}

/** 再生を始めてから elapsedMs 後の場面 */
export const gameSceneAt = (game: Game, elapsedMs: number): GameScene => {
  const done = elapsedMs >= game.totalMs
  const resultStart = game.totalMs - RESULT_MS
  if (elapsedMs >= game.collapseStartMs) {
    const poses = collapsePosesAt(game.collapse, (elapsedMs - game.collapseStartMs) * COLLAPSE_PLAYBACK_RATE)
    if (elapsedMs < resultStart) return { phase: 'collapse', poses, spin: null, result: null, done }
    const loser = game.touchdown.player
    return { phase: 'result', poses, spin: null, result: { loser, winner: opponentOf(loser), joint: game.touchdown.joint }, done }
  }
  const poses = standingPosesAt(game.plan, elapsedMs)
  const spin = spinAt(game, elapsedMs)
  if (spin === null) return { phase: 'intro', poses, spin, result: null, done }
  const phase: GamePhase = spin.elapsedMs < SPIN_MS ? 'spin' : spin.final ? 'reach' : 'move'
  return { phase, poses, spin, result: null, done }
}
