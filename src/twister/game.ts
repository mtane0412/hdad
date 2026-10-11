/**
 * ツイスターの1回の対戦の進み方
 *
 * 対戦は種（seed）だけから決まる。createGame が指示の並び（plan.ts）を決め、倒れ込み（physics.ts）を先に計算して記録する。
 * 場面と2人の姿勢は、再生を始めてからの経過時間だけから決まる（gameSceneAt。フレーム間の状態を持たない）。
 *
 * 流れ:
 * 1. 登場（INTRO_MS）: 2人が四つんばいで向かい合う
 * 2. 絡ませる指示を5〜7回: スピナーを回し、指された手足を弧を描いて指された円へ運ぶ。
 *    はじめの SLOW_TURN_COUNT 手はゆっくり（SLOW_PACE）、それより後は速く（FAST_PACE）回して運ぶ（paceOf）
 * 3. 最後の指示: 速くスピナーを回し、届かない円へ手足を伸ばし（REACH_MS）、倒れ込む（記録をスローモーションで再生する）
 * 4. 結果（RESULT_MS）: 先にマットに着いた人の負けとして、勝者を出す
 *
 * 倒れ込むまでの姿勢は、その時刻の手足の位置から IK で解いた姿勢（pose.ts）を目標にし、2人の体のめり込みを押し出して求める。
 * 押し出しは前のコマの結果から続けて解く（physics.ts の relaxFollowing）ので、倒れ込みと同じく対戦を作るときに1コマずつ記録し、
 * 再生ではその記録を経過時間で引く（bakeStanding）。毎コマ押し出し直すと、関節が相手の骨の中心線をまたぐたびに姿勢が飛ぶためである。
 * 手足を運ぶ経路は、いまの弧で運んで関節が速く動いたり運び終えるのが遅れたりしたら、経路の候補（path.ts）を記録し直して選ぶ（bakeStanding）。
 * 裏返る指示（plan.ts の flip）では、手を運ぶ進み具合に合わせて体を背骨のまわりに回し、うつ伏せから仰向けへ裏返す（運ぶ手の側が上がる）。
 * 裏返った人は、その対戦のあいだ仰向けのまま解く。
 * 2人の胴が上から見て近づいたら、片方を下にして伏せさせ、もう片方がその上に重なるようにする（stackingAt）。
 * 下になるのは、対戦のなかで最初に胴が重なった指示で手足を動かした人の相手（上に乗り込まれた人）で、その対戦のあいだ入れ替えない。
 * 倒れ込みの計算は、この求め方で出した倒れはじめの姿勢から始めるので、場面の切り替わりで姿勢が飛ばない。
 */
import { createRandom } from '../core/background'
import { JOINTS, LIMB_CHAINS, LIMBS, type Joint, type Limb, type Pose } from './body'
import { FLIP_ARC_HEIGHT, crouchOf, placementsAfter, planGame, rollSideOf, supineAfter, type Move, type Plan } from './plan'
import {
  COLLAPSE_FRAME_MS,
  PHYSICS_STEP_MS,
  bakeCollapse,
  collapsePosesAt,
  recordedPosesAt,
  relaxFollowing,
  relaxPoses,
  type Collapse,
  type Pins,
  type PosePair,
  type Touchdown,
} from './physics'
import { PLAYER_FACINGS, PLAYER_INDEXES, opponentOf, type PlayerIndex } from './players'
import { PATH_SHAPES, easeInOut, pointOnPath, shapedPath, windowScore, type Landing, type LimbPath } from './path'
import { contactsOf, restingOn, solvePose, type Contacts, type Posture } from './pose'
import { add, distance, flat, length, normalize, scale, sub, type Vec3 } from './vec'

/** 登場の長さ（ミリ秒） */
export const INTRO_MS = 3000
/** 1手の速さ */
export interface TurnPace {
  /** スピナーの針が回っている長さ（ミリ秒） */
  readonly turnMs: number
  /** スピナーを回して結果を見せる長さ（ミリ秒）。針が止まってから（turnMs の後）結果を読む間を含む */
  readonly spinMs: number
  /** 指された手足を運ぶ長さ（ミリ秒）。最後の指示では使わない（REACH_MS で伸ばす） */
  readonly moveMs: number
}
/** はじめの手番の速さ。スピナーと指示の読み方を、見ている人がつかめるようにゆっくり見せる */
export const SLOW_PACE: TurnPace = { turnMs: 1800, spinMs: 2600, moveMs: 1400 }
/** 後半の手番の速さ。手数を重ねても対戦が長くなりすぎないよう、テンポを上げる */
export const FAST_PACE: TurnPace = { turnMs: 1000, spinMs: 1600, moveMs: 1000 }
/** ゆっくり見せる手番の数 */
const SLOW_TURN_COUNT = 2
/** 最後の指示で、届かない円へ手足を伸ばす長さ（ミリ秒） */
export const REACH_MS = 900
/**
 * 倒れ込みを再生する速さ（物理の時間に対する割合）。倒れ込みは物理の時間では1秒足らずで終わり、配信の画面では何が起きたか追えないので、
 * スローモーションで見せる
 */
export const COLLAPSE_PLAYBACK_RATE = 0.4
/** 勝者を出す長さ（ミリ秒） */
export const RESULT_MS = 5500
/** 運び終えた手足が遅れていたとき、円へ近づける1コマの距離（m）。手足を運ぶいちばん速い速さ（1コマ 3〜4cm）に合わせる */
const LANDING_STEP = 0.04
/** 倒れはじめるまでの姿勢を記録する間隔の目安（ミリ秒）。60fps の1コマ。実際の間隔は、倒れはじめる時刻をちょうど割り切る長さにする */
const STANDING_FRAME_MS = 1000 / 60
/** 手足を運ぶときに持ち上げる高さ（m）。経路の候補（path.ts の PATH_SHAPES）の高さはこれに足す */
const MOVE_ARC_HEIGHT = 0.25
/** 最後の指示で手足を伸ばすときに持ち上げる高さ（m）。経路の候補の高さはこれに足す */
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
  /** 胴が重なったときに下になる人。一度も重ならない対戦では null（underOf） */
  readonly under: PlayerIndex | null
  /** 先に計算した、倒れはじめるまでの姿勢（bakeStanding） */
  readonly standing: StandingRecord
  /** 指示ごとに選んだ、手足を運ぶ経路（plan.moves の順に並び、最後に最後の指示の経路が続く。bakeStanding が選ぶ） */
  readonly paths: readonly LimbPath[]
}

/** 倒れはじめるまでの姿勢の記録 */
export interface StandingRecord {
  /** frameMs ごとの2人の姿勢。先頭は再生を始めた時刻、最後は倒れはじめる時刻の姿勢 */
  readonly frames: readonly PosePair[]
  /** 記録の間隔（ミリ秒） */
  readonly frameMs: number
}

/** 胴が重なったときの上下 */
export interface Stacking {
  /** 下になって伏せる人 */
  readonly bottom: PlayerIndex
  /** 伏せる度合い（0より大きく1以下）。胴が近いほど大きい */
  readonly crouch: number
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
  /** この手番でスピナーの針が回っている長さ（ミリ秒）。これを過ぎたら針は止まり、指示を読める */
  readonly turnMs: number
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

const clampProgress = (elapsedMs: number, spanMs: number): number => Math.min(Math.max(elapsedMs / spanMs, 0), 1)

/** i 回目（0から）の指示の速さ。最後の指示も、絡ませる指示の続きの番号で決める */
export const paceOf = (index: number): TurnPace => (index < SLOW_TURN_COUNT ? SLOW_PACE : FAST_PACE)

/** i 回目（0から）の指示のスピナーを回しはじめる時刻。それより前の手番の長さを足していく */
export const spinStartOf = (index: number): number => {
  let start = INTRO_MS
  for (let previous = 0; previous < index; previous += 1) {
    const pace = paceOf(previous)
    start += pace.spinMs + pace.moveMs
  }
  return start
}

/** 手足を動かしている途中の1本（動かしていなければ null） */
interface Motion {
  readonly player: PlayerIndex
  readonly limb: Limb
  readonly position: Vec3
  /** 裏返る指示なら、裏返った度合い（0〜1。手を運ぶ進み具合と同じ緩急で進む）。裏返らない指示なら null */
  readonly supine: number | null
}

/** 倒れ込むまでの時刻に運んでいる途中の手足（運んでいなければ null） */
type StandingMoving = { readonly player: PlayerIndex; readonly limb: Limb } | null

/**
 * 指示ごと（最後の指示を含む）の、いまの弧（path.ts の PATH_SHAPES の先頭の形）。
 * 裏返る指示は FLIP_ARC_HEIGHT の弧で運ぶ（plan.ts が、その弧の頂点で体を半分回した姿勢（flipMidPose）を見て、
 * 裏返る指示として成り立つかを決めているため、ほかの経路の候補も試さない）
 */
const basePathsOf = (plan: Plan): readonly LimbPath[] =>
  [...plan.moves, plan.finalMove].map((move, index) => {
    const before = placementsAfter(plan.moves.slice(0, index))
    const height = move.flip ? FLIP_ARC_HEIGHT : index === plan.moves.length ? REACH_ARC_HEIGHT : MOVE_ARC_HEIGHT
    return { from: restingOn(before[move.player][move.limb], move.limb), to: restingOn(move.spot, move.limb), height, swing: 0 }
  })

/** i 番目（0から。最後の指示は plan.moves の数）の経路。無ければ計算の誤りとして投げる */
const pathAt = (paths: readonly LimbPath[], index: number): LimbPath => {
  const path = paths[index]
  if (path === undefined) throw new Error(`${index + 1}回目の指示の経路がありません`)
  return path
}

/** 倒れ込むまでの時刻の、終えた指示と動かしている途中の手足（手足は paths の経路の上を運ぶ） */
const motionAt = (plan: Plan, paths: readonly LimbPath[], elapsedMs: number): { done: readonly Move[]; motion: Motion | null } => {
  const { moves, finalMove } = plan
  const doneCount = moves.filter((_, index) => elapsedMs >= spinStartOf(index + 1)).length
  const done = moves.slice(0, doneCount)
  const moving = moves[doneCount]
  if (moving !== undefined) {
    const pace = paceOf(doneCount)
    const moveStart = spinStartOf(doneCount) + pace.spinMs
    if (elapsedMs < moveStart) return { done, motion: null }
    const progress = clampProgress(elapsedMs - moveStart, pace.moveMs)
    const position = pointOnPath(pathAt(paths, doneCount), progress)
    return { done, motion: { player: moving.player, limb: moving.limb, position, supine: moving.flip ? easeInOut(progress) : null } }
  }
  // 絡ませる指示を終えたら、最後の指示で届かない円へ手足を伸ばす
  const reachStart = spinStartOf(moves.length) + paceOf(moves.length).spinMs
  if (elapsedMs < reachStart) return { done, motion: null }
  const position = pointOnPath(pathAt(paths, moves.length), clampProgress(elapsedMs - reachStart, REACH_MS))
  return { done, motion: { player: finalMove.player, limb: finalMove.limb, position, supine: null } }
}

/** 姿勢の手足の先を、そのまま留める位置にする（めり込みを押し出すときに手足を動かさない） */
const pinsOf = (pose: Pose): Pins => ({ handL: pose.handL, handR: pose.handR, footL: pose.footL, footR: pose.footR })

/** 手足の先の位置から、伏せさせる前の2人の姿勢を解く（裏返った人・裏返る途中の人はその向きで） */
const solvePair = (contacts: readonly [Contacts, Contacts], postures: readonly [Posture, Posture]): PosePair => [
  solvePose(contacts[0], PLAYER_FACINGS[0], postures[0]),
  solvePose(contacts[1], PLAYER_FACINGS[1], postures[1]),
]

/** 指示を終えた時点の2人の向き（裏返った人は仰向け） */
const posturesAfter = (moves: readonly Move[]): readonly [Posture, Posture] => [{ supine: supineAfter(moves, 0) ? 1 : 0 }, { supine: supineAfter(moves, 1) ? 1 : 0 }]

/**
 * 胴が重なったときに下になる人を決める。指示（最後の指示を含む）を順にたどり、手足を運び終えた姿勢で胴が近づいた最初の指示で
 * 動いた人の相手を下にする。一度も近づかなければ null。
 *
 * 運ぶ途中で近づき、運び終えたら離れる指示は見ない（その途中では、下になる人を動かしている人の相手として決める。standingAt）。
 */
const underOf = (plan: Plan): PlayerIndex | null => {
  const moves = [...plan.moves, plan.finalMove]
  const index = moves.findIndex((_, done) => {
    const finished = moves.slice(0, done + 1)
    const placements = placementsAfter(finished)
    return crouchOf(solvePair([contactsOf(placements[0]), contactsOf(placements[1])], posturesAfter(finished))) > 0
  })
  const first = moves[index]
  return first === undefined ? null : opponentOf(first.player)
}

/**
 * 倒れ込むまでの時刻の、2人の目標の姿勢（IK で解き、下になる人を伏せさせたもの。めり込みは押し出していない）と、
 * 胴が重なったときの上下と、運んでいる途中の手足
 */
const standingTargetAt = (
  plan: Plan,
  paths: readonly LimbPath[],
  under: PlayerIndex | null,
  elapsedMs: number,
): { target: PosePair; stacking: Stacking | null; moving: StandingMoving } => {
  const { done, motion } = motionAt(plan, paths, elapsedMs)
  const placements = placementsAfter(done)
  const contactsFor = (player: PlayerIndex): Contacts => {
    const contacts = contactsOf(placements[player])
    return motion !== null && motion.player === player ? { ...contacts, [motion.limb]: motion.position } : contacts
  }
  const contacts: readonly [Contacts, Contacts] = [contactsFor(0), contactsFor(1)]
  // 裏返る途中の人は、運ぶ手の側を上げながら回す
  const postureFor = (player: PlayerIndex): Posture =>
    motion !== null && motion.player === player && motion.supine !== null
      ? { supine: motion.supine, rollSide: rollSideOf(motion.limb) }
      : { supine: supineAfter(done, player) ? 1 : 0 }
  const postures: readonly [Posture, Posture] = [postureFor(0), postureFor(1)]
  const upright = solvePair(contacts, postures)
  const crouch = crouchOf(upright)
  let stacking: Stacking | null = null
  if (crouch > 0) {
    // 運び終えた姿勢では一度も重ならない対戦でも、運ぶ途中でかすめることがある。そのときは動かしている人の相手を下にする
    const bottom = under ?? (motion === null ? null : opponentOf(motion.player))
    if (bottom === null) throw new Error(`経過 ${elapsedMs} ミリ秒で胴が重なっているのに、下になる人が決まっていません`)
    stacking = { bottom, crouch }
  }
  const target: PosePair =
    stacking === null
      ? upright
      : stacking.bottom === 0
        ? [solvePose(contacts[0], PLAYER_FACINGS[0], { ...postures[0], crouch: stacking.crouch }), upright[1]]
        : [upright[0], solvePose(contacts[1], PLAYER_FACINGS[1], { ...postures[1], crouch: stacking.crouch })]
  return { target, stacking, moving: motion === null ? null : { player: motion.player, limb: motion.limb } }
}

/**
 * 手足の先を留める位置。
 *
 * 運んでいる途中の手足は留めず、相手の体に当たったら押し返されながら目標を追いかけさせる（弧の上に留めると相手の体を突き抜け、
 * 相手の体を押しのけて飛ばす）。運び終えた手足は、前のコマの位置から目標の円へ LANDING_STEP まで近づけた位置に留める。
 * 押し返されて遅れていても、相手の体を少しずつ押しのけながら数コマで円に着く（いきなり円へ留めると、その瞬間に飛ぶ）。
 */
const pinsOfPair = (target: PosePair, previous: PosePair, moving: StandingMoving): readonly [Pins, Pins] => {
  const pinsFor = (player: PlayerIndex): Pins => {
    const pins: Partial<Record<Limb, Vec3>> = {}
    for (const limb of LIMBS) {
      if (moving !== null && moving.player === player && moving.limb === limb) continue
      const from = previous[player][limb]
      const toward = sub(target[player][limb], from)
      const gap = length(toward)
      pins[limb] = gap <= LANDING_STEP ? target[player][limb] : add(from, scale(toward, LANDING_STEP / gap))
    }
    return pins
  }
  return [pinsFor(0), pinsFor(1)]
}

/** 2人の姿勢が、すべての関節でまったく同じ位置か（誤差を許さない。使い回しても記録が1ビットも変わらないことを保つため） */
const samePosePair = (a: PosePair, b: PosePair): boolean =>
  PLAYER_INDEXES.every((player) =>
    JOINTS.every((joint) => {
      const p = a[player][joint]
      const q = b[player][joint]
      return p.x === q.x && p.y === q.y && p.z === q.z
    }),
  )

/** 運んでいる途中の手足が同じか（どちらも運んでいない場合を含む） */
const sameMoving = (a: StandingMoving, b: StandingMoving): boolean =>
  a === null || b === null ? a === b : a.player === b.player && a.limb === b.limb

/** 記録を続けるのに要る、直前のコマの状態 */
interface BakeState {
  /** 直前のコマで記録した姿勢 */
  readonly poses: PosePair
  /** 直前のコマの目標の姿勢と、運んでいた手足 */
  readonly target: PosePair
  readonly moving: StandingMoving
  /** 直前のコマで、押し出しても姿勢が動かなかったか */
  readonly settled: boolean
}

/**
 * from 番目から to 番目（どちらも含む）のコマを、直前のコマの状態から続けて記録し、frames に足す。
 *
 * 押し出しが落ち着いた（前のコマの姿勢から押し出しても1ビットも動かなかった）あと、目標の姿勢と運んでいる手足が前のコマと
 * まったく同じあいだは、押し出しを省いて前のコマの記録を使い回す（#325）。relaxFollowing は同じ入力から必ず同じ結果を返すので、
 * 省いても記録は変わらない。登場とスピナーを回すあいだ（手足を動かさない区間）が該当し、記録するコマの半分ほどを省ける。
 *
 * @returns to 番目のコマの状態
 */
const bakeFrames = (
  plan: Plan,
  paths: readonly LimbPath[],
  under: PlayerIndex | null,
  frameMs: number,
  state: BakeState,
  range: { readonly from: number; readonly to: number },
  frames: PosePair[],
): BakeState => {
  let { poses: previous, target: previousTarget, moving: previousMoving, settled } = state
  for (let index = range.from; index <= range.to; index += 1) {
    const { target, moving } = standingTargetAt(plan, paths, under, index * frameMs)
    const unchanged = settled && sameMoving(moving, previousMoving) && samePosePair(target, previousTarget)
    if (!unchanged) {
      const next = relaxFollowing(previous, target, pinsOfPair(target, previous, moving))
      settled = samePosePair(next, previous)
      if (!settled) previous = next
    }
    previousTarget = target
    previousMoving = moving
    frames.push(previous)
  }
  return { poses: previous, target: previousTarget, moving: previousMoving, settled }
}

/**
 * 倒れはじめるまでの姿勢を1コマずつ記録し、指示ごとに手足を運ぶ経路を選ぶ。
 *
 * 先頭のコマは目標の姿勢からめり込みを押し出し、それより後のコマは前のコマの結果から目標を追いかけて押し出す（relaxFollowing）。
 * 記録の間隔は STANDING_FRAME_MS を目安に、倒れはじめる時刻をちょうど割り切る長さにする（最後のコマが倒れはじめの姿勢になる）。
 *
 * 手足を運ぶ区間（運びはじめから、次の指示のスピナーの針が止まるまで。最後の指示は倒れはじめるまで）では、まずいまの弧で運んで記録する。
 * 関節が速く動いたか運び終えるのが遅れたら、経路の候補（path.ts の PATH_SHAPES）を順に、同じ直前の状態から記録し直し、
 * 悪さ（path.ts の windowScore。骨どうしの突き抜けも数える）がいちばん小さい経路の記録を残す（同点なら先の候補）。
 * 関節が速く動かず遅れもしない候補が見つかったら、残りの候補は試さない（対戦を作る時間を抑えるため）。
 * 候補の順と比べ方は決まっていて乱数を使わないので、記録は種だけから決まる。裏返る指示はいまの弧のまま運ぶ（basePathsOf）。
 */
const bakeStanding = (plan: Plan, under: PlayerIndex | null, collapseStartMs: number): { record: StandingRecord; paths: readonly LimbPath[] } => {
  const count = Math.ceil(collapseStartMs / STANDING_FRAME_MS)
  const frameMs = collapseStartMs / count
  const paths = [...basePathsOf(plan)]
  const first = standingTargetAt(plan, paths, under, 0)
  const firstPoses = relaxPoses(first.target, pinsOfPair(first.target, first.target, first.moving))
  const frames: PosePair[] = [firstPoses]
  let state: BakeState = { poses: firstPoses, target: first.target, moving: first.moving, settled: false }
  let next = 1
  const moves = [...plan.moves, plan.finalMove]
  moves.forEach((move, index) => {
    const final = index === plan.moves.length
    // 運ぶ区間のコマの範囲と、運び終えた時刻のコマ
    const startFrame = Math.ceil((spinStartOf(index) + paceOf(index).spinMs) / frameMs)
    const endFrame = final ? count : Math.min(Math.floor((spinStartOf(index + 1) + paceOf(index + 1).turnMs) / frameMs), count)
    const landedFrame = Math.floor(spinStartOf(index + 1) / frameMs)
    if (next < startFrame) {
      state = bakeFrames(plan, paths, under, frameMs, state, { from: next, to: startFrame - 1 }, frames)
      next = startFrame
    }
    const landing: Landing | null = final ? null : { frame: landedFrame - next, gapOf: (poses) => distance(poses[move.player][move.limb], restingOn(move.spot, move.limb)) }
    const tryPath = (path: LimbPath): { path: LimbPath; window: PosePair[]; end: BakeState } => {
      const window: PosePair[] = []
      const trial = paths.map((original, at) => (at === index ? path : original))
      return { path, window, end: bakeFrames(plan, trial, under, frameMs, state, { from: next, to: endFrame }, window) }
    }
    const base = tryPath(pathAt(paths, index))
    let chosen = base
    if (!move.flip && !windowScore(state.poses, base.window, landing, false).clean) {
      let bestCost = windowScore(state.poses, base.window, landing, true).cost
      for (const shape of PATH_SHAPES.slice(1)) {
        const candidate = tryPath(shapedPath(pathAt(paths, index), shape))
        const score = windowScore(state.poses, candidate.window, landing, true)
        if (score.cost < bestCost) {
          bestCost = score.cost
          chosen = candidate
        }
        // 関節が速く動かず遅れもしない候補が見つかれば、残りの候補は試さない
        if (score.clean) break
      }
    }
    paths[index] = chosen.path
    frames.push(...chosen.window)
    state = chosen.end
    next = endFrame + 1
  })
  if (next <= count) bakeFrames(plan, paths, under, frameMs, state, { from: next, to: count }, frames)
  return { record: { frames, frameMs }, paths }
}

/**
 * 倒れはじめるまでの時刻の、胴が重なったときの上下。胴が離れていれば null。倒れはじめた後は扱わない（null）。
 */
export const stackingAt = (game: Game, elapsedMs: number): Stacking | null =>
  elapsedMs >= game.collapseStartMs ? null : standingTargetAt(game.plan, game.paths, game.under, elapsedMs).stacking

/**
 * 種から1回の対戦を作る（指示を決め、倒れ込みを先に計算する）。
 *
 * @throws 指示を決められない・誰もマットに着かない場合（どちらも計算の誤り）
 */
export const createGame = (seed: number): Game => {
  const plan = planGame(createRandom(seed))
  const under = underOf(plan)
  const collapseStartMs = spinStartOf(plan.moves.length) + paceOf(plan.moves.length).spinMs + REACH_MS
  const { record: standing, paths } = bakeStanding(plan, under, collapseStartMs)
  const poses = recordedPosesAt(standing.frames, standing.frameMs, collapseStartMs)
  const previous = recordedPosesAt(standing.frames, standing.frameMs, collapseStartMs - PHYSICS_STEP_MS)
  const { player, limb, spot } = plan.finalMove
  // 倒れる人は、伸ばした手足の付け根から指された円の向きへ倒れる
  const push = normalize(flat(sub(restingOn(spot, limb), poses[player][LIMB_CHAINS[limb].root])), PLAYER_FACINGS[player])
  const collapse = bakeCollapse({ poses, previous, pins: [pinsOf(poses[0]), pinsOf(poses[1])], faller: player, push })
  const collapseMs = ((collapse.frames.length - 1) * COLLAPSE_FRAME_MS) / COLLAPSE_PLAYBACK_RATE
  return { seed, plan, collapse, collapseStartMs, touchdown: collapse.touchdown, totalMs: collapseStartMs + collapseMs + RESULT_MS, under, standing, paths }
}

/** スピナーを出す場面なら、その指示 */
const spinAt = (game: Game, elapsedMs: number): SpinState | null => {
  const { moves, finalMove } = game.plan
  for (const [index, move] of moves.entries()) {
    const start = spinStartOf(index)
    if (elapsedMs >= start && elapsedMs < spinStartOf(index + 1)) return { move, index, final: false, elapsedMs: elapsedMs - start, turnMs: paceOf(index).turnMs }
  }
  const finalStart = spinStartOf(moves.length)
  if (elapsedMs >= finalStart && elapsedMs < game.collapseStartMs) {
    return { move: finalMove, index: moves.length, final: true, elapsedMs: elapsedMs - finalStart, turnMs: paceOf(moves.length).turnMs }
  }
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
  const poses = recordedPosesAt(game.standing.frames, game.standing.frameMs, elapsedMs)
  const spin = spinAt(game, elapsedMs)
  if (spin === null) return { phase: 'intro', poses, spin, result: null, done }
  const phase: GamePhase = spin.elapsedMs < paceOf(spin.index).spinMs ? 'spin' : spin.final ? 'reach' : 'move'
  return { phase, poses, spin, result: null, done }
}
