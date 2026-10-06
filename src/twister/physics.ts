/**
 * 人形の物理（関節を粒、骨を長さの決まった棒として動かす Verlet 積分）
 *
 * 使いみちは2つある。
 * - relaxPoses: 手足を動かしている最中の2人の体のめり込みを押し出す。重力も速度も持たず、その時刻の姿勢だけから求めるので、
 *   描画は経過時間だけから決まる（フレーム間の状態を持たない）という約束を守れる
 * - bakeCollapse: 最後の指示で倒れ込むところを、始めから終わりまで先に計算して記録する。物理はフレームごとに状態を持つので、
 *   再生のたびに計算せず、記録を経過時間で引く（collapsePosesAt）。勝敗（先にマットに着いた人と部位）もここで決まる
 *
 * 骨の長さ（と胴の形を保つための対角の長さ）は、渡された姿勢での長さをそのまま保つ。肘・膝の曲がる向きは縛らないので、
 * 倒れ込むときは関節が逆に曲がることもある（人形の動きとして許す）。
 * 同じ体どうしのぶつかりは扱わず、相手の骨との重なりとマットとの重なりだけを押し出す。
 *
 * 注意: 同じ入力からは必ず同じ結果になる（乱数を使わず、時間の刻みも固定）。勝敗をこの計算だけで決めるためである。
 */
import { BONES, JOINT_RADII, JOINTS, LIMBS, LOSING_JOINTS, poseFrom, type Joint, type Limb, type Pose } from './body'
import { opponentOf, type PlayerIndex } from './players'
import { UP, lerp, vec, type Vec3 } from './vec'

/** 手足を留めておく位置（留めない手足は書かない） */
export type Pins = Readonly<Partial<Record<Limb, Vec3>>>
/** 2人の姿勢（0: レイドした人、1: 配信者） */
export type PosePair = readonly [Pose, Pose]

/** 物理の時間の刻み（ミリ秒）。細かいほど骨が伸び縮みしにくい */
export const PHYSICS_STEP_MS = 1000 / 120
const STEP_MS = PHYSICS_STEP_MS
/** 記録する間隔の刻み数 */
const STEPS_PER_FRAME = 2
/** 記録の間隔（ミリ秒）。60fps の1コマに合わせる */
export const COLLAPSE_FRAME_MS = STEP_MS * STEPS_PER_FRAME
/** マットに着いてから記録を続ける長さ（ミリ秒）。倒れきるところまで映す */
export const COLLAPSE_AFTER_TOUCHDOWN_MS = 1800
/** 倒れ込みを計算する長さの上限（ミリ秒）。これまでに誰もマットに着かなければ計算の誤りとして投げる */
const MAX_COLLAPSE_MS = 6000
/** 重力（m/s²） */
const GRAVITY = 9.8
/** 1刻みで長さ・ぶつかりを満たし直す回数 */
const ITERATIONS = 8
/** めり込みを押し出すだけのときに満たし直す回数 */
const RELAX_ITERATIONS = 12
/** 速度の減り方（1刻みごとに掛ける）。空気の抵抗の代わり */
const DAMPING = 0.995
/** マットに触れている粒の、水平の速度の減り方（摩擦） */
const GROUND_FRICTION = 0.5
/** マットに着いたとみなす隙間（m） */
const TOUCH_MARGIN = 0.004
/** 倒れる人を押し出す速さ（m/s）と、下へ落とす速さ（m/s） */
const FALL_SPEED = 0.9
const DROP_SPEED = 0.3
/**
 * 体を支えているあいだ（relaxPoses）、手足の先のほかの部位をマットから浮かせておく高さ（m）。
 * 絡み合って相手の体に押し下げられても、倒れ込む前にひじ・ひざがマットに着いて決着してしまわないようにする
 */
export const STANDING_CLEARANCE = 0.05
/** 倒れる人とぶつかった相手が、手足を離すめり込みの深さ（m） */
const KNOCK_DEPTH = 0.015
/** ぶつからなくても相手が手足を離す時刻（ミリ秒）。倒れる人の揺れで体勢を崩す */
const KNOCK_FALLBACK_MS = 1200

/** 胴の形を保つため、骨のほかに長さを保つ関節の組（肩幅・腰幅・胴の対角・頭の付き方） */
const BRACES: readonly (readonly [Joint, Joint])[] = [
  ['head', 'neck'],
  ['head', 'shoulderL'],
  ['head', 'shoulderR'],
  ['head', 'pelvis'],
  ['neck', 'shoulderL'],
  ['neck', 'shoulderR'],
  ['neck', 'pelvis'],
  ['neck', 'hipL'],
  ['neck', 'hipR'],
  ['shoulderL', 'shoulderR'],
  ['shoulderL', 'hipL'],
  ['shoulderR', 'hipR'],
  ['shoulderL', 'hipR'],
  ['shoulderR', 'hipL'],
  ['pelvis', 'shoulderL'],
  ['pelvis', 'shoulderR'],
  ['pelvis', 'hipL'],
  ['pelvis', 'hipR'],
  ['hipL', 'hipR'],
  ['shoulderL', 'elbowL'],
  ['elbowL', 'handL'],
  ['shoulderR', 'elbowR'],
  ['elbowR', 'handR'],
  ['hipL', 'kneeL'],
  ['kneeL', 'footL'],
  ['hipR', 'kneeR'],
  ['kneeR', 'footR'],
]
/** 折りたたみすぎないよう、これより近づけない関節の組と距離（m）。手が肩に、足が腰にめり込むのを防ぐ */
const MIN_SPANS: readonly (readonly [Joint, Joint, number])[] = [
  ['shoulderL', 'handL', 0.2],
  ['shoulderR', 'handR', 0.2],
  ['hipL', 'footL', 0.25],
  ['hipR', 'footR', 0.25],
]

/** 粒（関節1つ）。位置と1刻み前の位置を持つ（Verlet 積分では差が速度になる） */
interface Particle {
  x: number
  y: number
  z: number
  px: number
  py: number
  pz: number
  readonly radius: number
  /** これより下へは沈ませない高さ（粒の中心の高さ。m）。体を支えるのをやめたら radius まで下げる */
  floor: number
  pin: Vec3 | null
}

/** 長さを保つ関節の組。min なら、その長さより近づけないだけにする */
interface Span {
  readonly a: number
  readonly b: number
  readonly rest: number
  readonly min: boolean
}

/** 相手の体とのぶつかりに使う骨 */
interface Segment {
  readonly player: PlayerIndex
  readonly a: number
  readonly b: number
  readonly radius: number
}

interface World {
  readonly particles: readonly Particle[]
  readonly spans: readonly Span[]
  readonly segments: readonly Segment[]
}

/** 粒の並びでの位置（1人あたり JOINTS の数だけ並ぶ） */
const indexOf = (player: PlayerIndex, joint: Joint): number => player * JOINTS.length + JOINTS.indexOf(joint)

const playerOfIndex = (index: number): PlayerIndex => (index < JOINTS.length ? 0 : 1)

const at = <T,>(items: readonly T[], index: number): T => {
  const item = items[index]
  if (item === undefined) throw new Error(`物理の粒 ${index} がありません`)
  return item
}

const gap = (a: Particle, b: Particle): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/**
 * 2人の姿勢から、粒と長さの組を作る。長さは渡された姿勢での長さを保つ。
 *
 * @param clearances 人ごとの、手足の先のほかの部位をマットから浮かせておく高さ（m）
 */
const createWorld = (poses: PosePair, previous: PosePair, pins: readonly [Pins, Pins], clearances: readonly [number, number]): World => {
  const particles: Particle[] = []
  for (const player of [0, 1] as const) {
    for (const joint of JOINTS) {
      const position = poses[player][joint]
      const before = previous[player][joint]
      const pin = (LIMBS as readonly string[]).includes(joint) ? (pins[player][joint as Limb] ?? null) : null
      const radius = JOINT_RADII[joint]
      const floor = radius + (LOSING_JOINTS.includes(joint) ? clearances[player] : 0)
      particles.push({ x: position.x, y: position.y, z: position.z, px: before.x, py: before.y, pz: before.z, radius, floor, pin })
    }
  }
  const spans: Span[] = []
  const segments: Segment[] = []
  for (const player of [0, 1] as const) {
    for (const [from, to] of BRACES) {
      const a = indexOf(player, from)
      const b = indexOf(player, to)
      spans.push({ a, b, rest: gap(at(particles, a), at(particles, b)), min: false })
    }
    for (const [from, to, rest] of MIN_SPANS) spans.push({ a: indexOf(player, from), b: indexOf(player, to), rest, min: true })
    for (const bone of BONES) segments.push({ player, a: indexOf(player, bone.from), b: indexOf(player, bone.to), radius: bone.radius })
  }
  return { particles, spans, segments }
}

/** 長さの組を満たすよう、両端を半分ずつ動かす（留めた粒は動かさず、相手が全部動く） */
const satisfySpans = (world: World): void => {
  for (const span of world.spans) {
    const a = at(world.particles, span.a)
    const b = at(world.particles, span.b)
    const current = gap(a, b)
    if (current < 1e-9 || (span.min && current >= span.rest)) continue
    const weightA = a.pin === null ? 1 : 0
    const weightB = b.pin === null ? 1 : 0
    const total = weightA + weightB
    if (total === 0) continue
    const diff = (current - span.rest) / current / total
    const dx = (b.x - a.x) * diff
    const dy = (b.y - a.y) * diff
    const dz = (b.z - a.z) * diff
    a.x += dx * weightA
    a.y += dy * weightA
    a.z += dz * weightA
    b.x -= dx * weightB
    b.y -= dy * weightB
    b.z -= dz * weightB
  }
}

/**
 * 粒が相手の骨にめり込んでいたら押し出す。粒と骨の両端を、めり込みの深さの半分ずつ反対へ動かす。
 *
 * @returns いちばん深かっためり込み（m）。ぶつかった相手が手足を離すかの判断に使う
 */
const separatePlayers = (world: World): number => {
  let deepest = 0
  world.particles.forEach((particle, index) => {
    const player = playerOfIndex(index)
    for (const segment of world.segments) {
      if (segment.player === player) continue
      const a = at(world.particles, segment.a)
      const b = at(world.particles, segment.b)
      // 骨の上で粒にいちばん近い位置
      const abx = b.x - a.x
      const aby = b.y - a.y
      const abz = b.z - a.z
      const squared = abx * abx + aby * aby + abz * abz
      const ratio = squared < 1e-12 ? 0 : Math.min(1, Math.max(0, ((particle.x - a.x) * abx + (particle.y - a.y) * aby + (particle.z - a.z) * abz) / squared))
      const cx = a.x + abx * ratio
      const cy = a.y + aby * ratio
      const cz = a.z + abz * ratio
      const dist = Math.hypot(particle.x - cx, particle.y - cy, particle.z - cz)
      const depth = particle.radius + segment.radius - dist
      if (depth <= 0) continue
      deepest = Math.max(deepest, depth)
      // ちょうど重なって向きが決まらないときは、上へ押し出す
      const nx = dist < 1e-9 ? UP.x : (particle.x - cx) / dist
      const ny = dist < 1e-9 ? UP.y : (particle.y - cy) / dist
      const nz = dist < 1e-9 ? UP.z : (particle.z - cz) / dist
      const moveParticle = particle.pin === null ? 1 : 0
      const moveA = a.pin === null ? 1 - ratio : 0
      const moveB = b.pin === null ? ratio : 0
      const total = moveParticle + moveA + moveB
      if (total === 0) continue
      const share = depth / total
      particle.x += nx * share * moveParticle
      particle.y += ny * share * moveParticle
      particle.z += nz * share * moveParticle
      a.x -= nx * share * moveA
      a.y -= ny * share * moveA
      a.z -= nz * share * moveA
      b.x -= nx * share * moveB
      b.y -= ny * share * moveB
      b.z -= nz * share * moveB
    }
  })
  return deepest
}

/** マットより下に沈んだ粒を押し上げ、留めた粒を留めた位置へ戻す */
const keepOnMatAndPins = (world: World): void => {
  for (const particle of world.particles) {
    if (particle.y < particle.floor) particle.y = particle.floor
    if (particle.pin !== null) {
      particle.x = particle.pin.x
      particle.y = particle.pin.y
      particle.z = particle.pin.z
    }
  }
}

/** 長さ・ぶつかり・マット・留め具を満たし直す。いちばん深かっためり込みを返す */
const solveConstraints = (world: World, iterations: number): number => {
  let deepest = 0
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    satisfySpans(world)
    deepest = Math.max(deepest, separatePlayers(world))
    keepOnMatAndPins(world)
  }
  return deepest
}

/** 粒の位置から2人の姿勢を作る */
const posesOf = (world: World): PosePair => {
  const poseOf = (player: PlayerIndex): Pose =>
    poseFrom((joint) => {
      const particle = at(world.particles, indexOf(player, joint))
      return vec(particle.x, particle.y, particle.z)
    })
  return [poseOf(0), poseOf(1)]
}

/**
 * 2人の体のめり込みを押し出す（重力も速度も持たない）。
 *
 * 体が離れていれば姿勢をそのまま返す。留めた手足は動かさない。手足の先のほかの部位は、マットから STANDING_CLEARANCE だけ浮かせる。
 */
export const relaxPoses = (poses: PosePair, pins: readonly [Pins, Pins]): PosePair => {
  const world = createWorld(poses, poses, pins, [STANDING_CLEARANCE, STANDING_CLEARANCE])
  solveConstraints(world, RELAX_ITERATIONS)
  return posesOf(world)
}

/** 倒れ込みの計算に渡すもの */
export interface CollapseInput {
  /** 倒れはじめの2人の姿勢 */
  readonly poses: PosePair
  /** 倒れはじめの1刻み（STEP_MS）前の姿勢。差が倒れはじめの速度になる */
  readonly previous: PosePair
  /** 倒れはじめに留めていた手足。倒れる人の手足はすぐ離し、相手の手足はぶつかられたら離す */
  readonly pins: readonly [Pins, Pins]
  /** 倒れる人 */
  readonly faller: PlayerIndex
  /** 倒れる人を押し出す水平の向き（長さ1） */
  readonly push: Vec3
}

/** 先にマットに着いた人と部位と時刻（倒れはじめからのミリ秒） */
export interface Touchdown {
  readonly player: PlayerIndex
  readonly joint: Joint
  readonly atMs: number
}

/** 先に計算した倒れ込み */
export interface Collapse {
  /** COLLAPSE_FRAME_MS ごとの2人の姿勢。先頭は倒れはじめの姿勢 */
  readonly frames: readonly PosePair[]
  readonly touchdown: Touchdown
}

/** 手足の先のほかの部位でマットに着いている部位のうち、いちばん沈んでいるもの */
const touchdownOf = (world: World, players: readonly PlayerIndex[]): { player: PlayerIndex; joint: Joint } | null => {
  let found: { player: PlayerIndex; joint: Joint; clearance: number } | null = null
  for (const player of players) {
    for (const joint of LOSING_JOINTS) {
      const particle = at(world.particles, indexOf(player, joint))
      const clearance = particle.y - particle.radius
      if (clearance <= TOUCH_MARGIN && (found === null || clearance < found.clearance)) found = { player, joint, clearance }
    }
  }
  return found === null ? null : { player: found.player, joint: found.joint }
}

/**
 * 倒れ込みを先に計算して記録する。
 *
 * 倒れる人は手足を離し、押し出す向きと下へ速度を足して倒す。相手は、倒れる人にぶつかられる（めり込みが KNOCK_DEPTH を超える）か、
 * KNOCK_FALLBACK_MS が過ぎたら手足を離す。手足の先のほかの部位が先にマットに着いた人が負けで、同じ刻みなら深く沈んだほう、
 * それも同じなら倒れる人を負けにする。
 *
 * @throws MAX_COLLAPSE_MS までに誰もマットに着かなかった場合（倒れる人は支えを失うので、着かないのは計算の誤り）
 */
export const bakeCollapse = (input: CollapseInput): Collapse => {
  const other = opponentOf(input.faller)
  const pins: readonly [Pins, Pins] = input.faller === 0 ? [{}, input.pins[1]] : [input.pins[0], {}]
  // 相手は、ぶつかられて手足を離すまで体を支えている（部位をマットから浮かせたままにする）
  const clearances: readonly [number, number] = input.faller === 0 ? [0, STANDING_CLEARANCE] : [STANDING_CLEARANCE, 0]
  const world = createWorld(input.poses, input.previous, pins, clearances)
  const dt = STEP_MS / 1000
  // 倒れる人の粒に、押し出す向きと下への速度を足す（1刻み前の位置をずらす）
  world.particles.forEach((particle, index) => {
    if (playerOfIndex(index) !== input.faller) return
    particle.px -= input.push.x * FALL_SPEED * dt
    particle.py -= (input.push.y * FALL_SPEED - DROP_SPEED) * dt
    particle.pz -= input.push.z * FALL_SPEED * dt
  })

  const frames: PosePair[] = [input.poses]
  let touchdown: Touchdown | null = null
  let knocked = false
  for (let step = 1; step * STEP_MS <= MAX_COLLAPSE_MS; step += 1) {
    const now = step * STEP_MS
    for (const particle of world.particles) {
      if (particle.pin !== null) continue
      const vx = (particle.x - particle.px) * DAMPING
      const vy = (particle.y - particle.py) * DAMPING
      const vz = (particle.z - particle.pz) * DAMPING
      particle.px = particle.x
      particle.py = particle.y
      particle.pz = particle.z
      particle.x += vx
      particle.y += vy - GRAVITY * dt * dt
      particle.z += vz
    }
    const deepest = solveConstraints(world, ITERATIONS)
    // マットに触れている粒は、水平の速度を摩擦で減らす
    for (const particle of world.particles) {
      if (particle.pin !== null || particle.y > particle.radius + 1e-4) continue
      particle.px = particle.x - (particle.x - particle.px) * (1 - GROUND_FRICTION)
      particle.pz = particle.z - (particle.z - particle.pz) * (1 - GROUND_FRICTION)
    }
    if (!knocked && (deepest > KNOCK_DEPTH || now >= KNOCK_FALLBACK_MS)) {
      knocked = true
      world.particles.forEach((particle, index) => {
        if (playerOfIndex(index) !== other) return
        particle.pin = null
        particle.floor = particle.radius
      })
    }
    if (touchdown === null) {
      const found = touchdownOf(world, [input.faller, other])
      if (found !== null) touchdown = { ...found, atMs: now }
    }
    if (step % STEPS_PER_FRAME === 0) frames.push(posesOf(world))
    if (touchdown !== null && frames.length * COLLAPSE_FRAME_MS >= touchdown.atMs + COLLAPSE_AFTER_TOUCHDOWN_MS) {
      return { frames, touchdown }
    }
  }
  if (touchdown === null) throw new Error(`倒れ込みを ${MAX_COLLAPSE_MS} ミリ秒計算しても、誰もマットに着きませんでした`)
  return { frames, touchdown }
}

/** 2つの姿勢を混ぜる */
const blendPose = (a: Pose, b: Pose, ratio: number): Pose => poseFrom((joint) => lerp(a[joint], b[joint], ratio))

/** 倒れはじめから elapsedMs 後の2人の姿勢。記録のあいだは前後を混ぜ、記録の終わりより後は最後の記録で止める */
export const collapsePosesAt = (collapse: Collapse, elapsedMs: number): PosePair => {
  const position = Math.max(0, elapsedMs) / COLLAPSE_FRAME_MS
  const index = Math.floor(position)
  const last = collapse.frames.length - 1
  if (index >= last) return at(collapse.frames, last)
  const before = at(collapse.frames, index)
  const after = at(collapse.frames, index + 1)
  const ratio = position - index
  return [blendPose(before[0], after[0], ratio), blendPose(before[1], after[1], ratio)]
}
