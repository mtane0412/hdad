/**
 * VRMの演出の動き方（種と経過時間から場面を決める）
 *
 * 1回の演出は「画面の外から歩いて出てくる → 正面を向く → 片手を上げて何回か振る → お辞儀する → 横を向いて歩いて帰る」の順に流れる。
 * どちらから出てくるか・どちらへ帰るか・どちらの手で何回振るか・お辞儀の深さは種だけから決め（createVrmPlan）、
 * その時刻の場面（位置・向き・骨ごとの回転・表情）は流しはじめてからの経過時間だけから求める（vrmSceneAt。フレーム間の状態を持たない）。
 *
 * 骨の回転は VRM の正規化された骨（three-vrm の normalized bone）に当てる値で、どの骨も初期の姿勢（T ポーズ）では回転 0 である。
 * キャラクターはカメラのほう（+Z）を向き、キャラクターの左手は +X 側にある。そのため
 * - 腕を下ろすには、右腕は Z 軸まわりに +、左腕は − に回す（ARM_REST_Z）。上げるのはその逆向き
 * - 前へ曲げる（お辞儀・脚を前へ出す）のは X 軸まわりの回転で、背中は +、脚を前へ出すのは − である
 *
 * 注意: 乱数は src/core/background.ts の createRandom だけを使い、Math.random を使わない（同じ種から同じ動きを再現するため）。
 * 注意: DOM も three.js も読み込まない（描画は view.ts が受け持つ）。髪や服の揺れ（SpringBone）は経過時間だけから決められないので使わない。
 */
import { createRandom } from '../core/background'

/** 動かす骨（VRM の humanoid の骨の名前） */
export const VRM_BONES = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'leftUpperArm',
  'leftLowerArm',
  'rightUpperArm',
  'rightLowerArm',
  'leftUpperLeg',
  'leftLowerLeg',
  'rightUpperLeg',
  'rightLowerLeg',
] as const

export type VrmBone = (typeof VRM_BONES)[number]

/** 骨1本の回転（ラジアン。three.js の Euler の XYZ の順に当てる） */
export interface BoneRotation {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** 左右（キャラクターから見た向きではなく、画面の左右。手だけはキャラクター自身の左右） */
export type VrmSide = 'left' | 'right'

/** 種から決めた1回ぶんの動き方 */
export interface VrmPlan {
  /** 画面のどちら側から歩いて出てくるか */
  readonly enterFrom: VrmSide
  /** 画面のどちら側へ歩いて帰るか */
  readonly exitTo: VrmSide
  /** どちらの手で振るか（キャラクター自身の左右） */
  readonly wavingHand: VrmSide
  /** 手を振る回数（往復の数） */
  readonly waveCount: number
  /** お辞儀の深さ（1 で既定の深さ） */
  readonly bowDepth: number
  /** 手を振りはじめる時刻（登場が終わる時刻。ミリ秒） */
  readonly waveStartMs: number
  /** お辞儀を始める時刻（ミリ秒） */
  readonly bowStartMs: number
  /** 帰りはじめる時刻（ミリ秒） */
  readonly exitStartMs: number
  /** 演出全体の長さ（ミリ秒）。これを過ぎたら終わり */
  readonly totalMs: number
}

export type VrmPhase = 'enter' | 'wave' | 'bow' | 'exit' | 'done'

/** その時刻の場面 */
export interface VrmScene {
  readonly phase: VrmPhase
  /** 立つ位置からのずれ。-1 で画面の左の外、0 で立つ位置、1 で画面の右の外 */
  readonly slide: number
  /** 体の向き（Y 軸まわりの回転。ラジアン）。0 で正面（カメラ）、+ で画面の右を向く */
  readonly facing: number
  /** 歩くときの上下の揺れ（3Dの単位。メートル） */
  readonly bob: number
  /** にっこりの表情の強さ（0〜1） */
  readonly happy: number
  readonly bones: Readonly<Record<VrmBone, BoneRotation>>
}

/** 腕を下ろしたときの、上腕の Z 軸まわりの回転の大きさ（右腕は +、左腕は −） */
export const ARM_REST_Z = 1.2
/** 手を振る回数の下限と上限 */
export const MIN_WAVES = 2
export const MAX_WAVES = 4
/** お辞儀の深さの下限と上限 */
const MIN_BOW_DEPTH = 0.8
const MAX_BOW_DEPTH = 1.1

/** 画面の外から立つ位置まで歩く長さと、立ち止まって正面を向く長さ（ミリ秒）。帰りは同じ長さで逆順にする */
const WALK_MS = 1600
const TURN_MS = 400
/** 腕を上げる・下ろす長さと、1往復振る長さ（ミリ秒） */
const RAISE_MS = 400
const WAVE_CYCLE_MS = 600
/** お辞儀で頭を下げる・下げたまま止める・戻す長さ（ミリ秒） */
const BOW_DOWN_MS = 600
const BOW_HOLD_MS = 500
const BOW_UP_MS = 600
/** 手を下ろしてからお辞儀を始めるまでの間（ミリ秒） */
const BOW_GAP_MS = 200

/** 歩くときに進む向きへ体を回す大きさ（ラジアン）。真横（π/2）まで回すと顔が見えなくなるので、斜めにとどめる */
const WALK_FACING = 1.1
/** 歩くときの1歩の長さ（ミリ秒。左右の2歩で1周）と、脚・膝・腕の振れ幅（ラジアン）、上下の揺れ（メートル） */
const STEP_MS = 400
const LEG_SWING = 0.45
const KNEE_BEND = 0.6
const ARM_SWING = 0.35
const WALK_BOB = 0.025
/** 手を振るとき、上腕を上げきった回転と、前腕を立てる回転、前腕を左右に振る振れ幅（ラジアン。右手の向き） */
const ARM_RAISED_Z = 0.25
const FOREARM_UP_Z = 1.1
const WAVE_SWING = 0.35
/** 手を振るのに合わせて首をかしげる大きさ（ラジアン） */
const HEAD_TILT = 0.08
/** お辞儀で背中・胸・首を前へ曲げる大きさ（ラジアン。深さ 1 のとき） */
const BOW_SPINE = 0.45
const BOW_CHEST = 0.2
const BOW_NECK = 0.2

const ZERO: BoneRotation = { x: 0, y: 0, z: 0 }

/** 0〜1 の進み具合を、はじめと終わりをなだらかにした進み具合にする */
const smooth = (progress: number): number => {
  const clamped = Math.min(1, Math.max(0, progress))
  return clamped * clamped * (3 - 2 * clamped)
}

/** 画面の左右を、位置のずれ・向きの符号にする（左が −、右が +） */
const signOf = (side: VrmSide): number => (side === 'left' ? -1 : 1)

/** 下限から上限までの値を、0〜1 の乱数で選ぶ */
const between = (random: () => number, min: number, max: number): number => min + (max - min) * random()

/**
 * 種から1回ぶんの動き方を決める。
 *
 * @param seed 0 以上 2^32 未満の整数（Worker が押し出す呼び出しの種）
 */
export const createVrmPlan = (seed: number): VrmPlan => {
  const random = createRandom(seed)
  const pickSide = (): VrmSide => (random() < 0.5 ? 'left' : 'right')
  const enterFrom = pickSide()
  const exitTo = pickSide()
  const wavingHand = pickSide()
  const waveCount = MIN_WAVES + Math.floor(random() * (MAX_WAVES - MIN_WAVES + 1))
  const bowDepth = between(random, MIN_BOW_DEPTH, MAX_BOW_DEPTH)

  const waveStartMs = WALK_MS + TURN_MS
  const bowStartMs = waveStartMs + RAISE_MS + waveCount * WAVE_CYCLE_MS + RAISE_MS + BOW_GAP_MS
  const exitStartMs = bowStartMs + BOW_DOWN_MS + BOW_HOLD_MS + BOW_UP_MS
  const totalMs = exitStartMs + TURN_MS + WALK_MS
  return { enterFrom, exitTo, wavingHand, waveCount, bowDepth, waveStartMs, bowStartMs, exitStartMs, totalMs }
}

/** 腕を下ろして立った姿勢の骨の回転 */
const standingBones = (): Record<VrmBone, BoneRotation> => {
  const bones = Object.fromEntries(VRM_BONES.map((bone) => [bone, ZERO])) as Record<VrmBone, BoneRotation>
  bones.rightUpperArm = { x: 0, y: 0, z: ARM_REST_Z }
  bones.leftUpperArm = { x: 0, y: 0, z: -ARM_REST_Z }
  return bones
}

/**
 * 歩いている姿勢にする。脚を前後に振り、膝を曲げ、腕を脚と逆に振る。
 *
 * @param walkedMs 歩きはじめてからの経過時間（ミリ秒）
 * @returns 上下の揺れ（メートル）
 */
const applyWalk = (bones: Record<VrmBone, BoneRotation>, walkedMs: number): number => {
  const swing = Math.sin((Math.PI * walkedMs) / STEP_MS)
  // 脚を前へ出すのは − の回転。左右は逆に振る
  bones.leftUpperLeg = { x: -LEG_SWING * swing, y: 0, z: 0 }
  bones.rightUpperLeg = { x: LEG_SWING * swing, y: 0, z: 0 }
  // 膝は後ろへだけ曲がる（+ の回転）。脚を後ろへ送っている側の膝を曲げる
  bones.leftLowerLeg = { x: KNEE_BEND * Math.max(0, swing), y: 0, z: 0 }
  bones.rightLowerLeg = { x: KNEE_BEND * Math.max(0, -swing), y: 0, z: 0 }
  // 腕は同じ側の脚と逆に振る
  bones.leftUpperArm = { ...bones.leftUpperArm, x: ARM_SWING * swing }
  bones.rightUpperArm = { ...bones.rightUpperArm, x: -ARM_SWING * swing }
  return WALK_BOB * Math.abs(swing)
}

/**
 * 手を振る姿勢にする。
 *
 * @param waveMs 手を振る区間に入ってからの経過時間（ミリ秒）
 * @returns 腕の上がり具合（0〜1。表情の強さにも使う）
 */
const applyWave = (bones: Record<VrmBone, BoneRotation>, plan: VrmPlan, waveMs: number): number => {
  const wavingMs = plan.waveCount * WAVE_CYCLE_MS
  const raise = smooth(waveMs / RAISE_MS) * (1 - smooth((waveMs - RAISE_MS - wavingMs) / RAISE_MS))
  // 振っているあいだだけ前腕を左右に振る（上げ下ろしの途中では振らない）
  const wavingElapsed = waveMs - RAISE_MS
  const swing = wavingElapsed >= 0 && wavingElapsed <= wavingMs ? Math.sin((2 * Math.PI * wavingElapsed) / WAVE_CYCLE_MS) : 0
  // 右手の向きで計算し、左手なら Z 軸まわりの回転を反転する（体の左右で鏡写しになるため）
  const mirror = plan.wavingHand === 'right' ? 1 : -1
  const upperZ = ARM_REST_Z + (-ARM_RAISED_Z - ARM_REST_Z) * raise
  const lowerZ = -FOREARM_UP_Z * raise + WAVE_SWING * swing
  if (plan.wavingHand === 'right') {
    bones.rightUpperArm = { x: 0, y: 0, z: upperZ }
    bones.rightLowerArm = { x: 0, y: 0, z: lowerZ }
  } else {
    bones.leftUpperArm = { x: 0, y: 0, z: -upperZ }
    bones.leftLowerArm = { x: 0, y: 0, z: -lowerZ }
  }
  bones.head = { x: 0, y: 0, z: mirror * HEAD_TILT * swing }
  return raise
}

/**
 * お辞儀の姿勢にする。
 *
 * @param bowMs お辞儀を始めてからの経過時間（ミリ秒）
 */
const applyBow = (bones: Record<VrmBone, BoneRotation>, plan: VrmPlan, bowMs: number): void => {
  const down = smooth(bowMs / BOW_DOWN_MS)
  const up = smooth((bowMs - BOW_DOWN_MS - BOW_HOLD_MS) / BOW_UP_MS)
  const bend = (down - up) * plan.bowDepth
  bones.spine = { x: BOW_SPINE * bend, y: 0, z: 0 }
  bones.chest = { x: BOW_CHEST * bend, y: 0, z: 0 }
  bones.neck = { x: BOW_NECK * bend, y: 0, z: 0 }
}

/**
 * 流しはじめてからの経過時間から、その時刻の場面を求める。
 *
 * @param elapsedMs 流しはじめてからの経過時間（ミリ秒）
 */
export const vrmSceneAt = (plan: VrmPlan, elapsedMs: number): VrmScene => {
  const bones = standingBones()
  const enterSign = signOf(plan.enterFrom)
  const exitSign = signOf(plan.exitTo)

  if (elapsedMs >= plan.totalMs) return { phase: 'done', slide: exitSign, facing: 0, bob: 0, happy: 0, bones }

  if (elapsedMs < plan.waveStartMs) {
    // 画面の外から立つ位置まで同じ速さで歩き、立ち止まったら正面へ向き直る。進む向きは出てくる側の逆
    const walked = Math.min(elapsedMs, WALK_MS)
    const bob = elapsedMs < WALK_MS ? applyWalk(bones, walked) : 0
    const turned = smooth((elapsedMs - WALK_MS) / TURN_MS)
    return { phase: 'enter', slide: enterSign * (1 - walked / WALK_MS), facing: -enterSign * WALK_FACING * (1 - turned), bob, happy: 0, bones }
  }

  if (elapsedMs < plan.bowStartMs) {
    const raise = applyWave(bones, plan, elapsedMs - plan.waveStartMs)
    return { phase: 'wave', slide: 0, facing: 0, bob: 0, happy: raise, bones }
  }

  if (elapsedMs < plan.exitStartMs) {
    applyBow(bones, plan, elapsedMs - plan.bowStartMs)
    return { phase: 'bow', slide: 0, facing: 0, bob: 0, happy: 1, bones }
  }

  // 帰る向きへ体を回してから、画面の外まで歩く。向き直るあいだに表情を戻す
  const exitMs = elapsedMs - plan.exitStartMs
  const turned = smooth(exitMs / TURN_MS)
  const walked = Math.max(0, exitMs - TURN_MS)
  const bob = walked > 0 ? applyWalk(bones, walked) : 0
  return { phase: 'exit', slide: exitSign * (walked / WALK_MS), facing: exitSign * WALK_FACING * turned, bob, happy: 1 - turned, bones }
}
