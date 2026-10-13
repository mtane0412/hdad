/**
 * VRMのマスコットの動き方（時刻と反応から場面を決める）
 *
 * マスコットは配信中ずっと立っていて、待機の動き（呼吸・瞬き・視線のゆらぎ）を続ける（issue #359）。
 * トリガーや試し再生の呼び出しが届くと、その場で反応を待機の動きに重ねる。反応の種類は4つで、トリガーの項目から Worker が決める。
 * - お礼（thanks）: 片手を上げて何回か振り、お辞儀する
 * - 手を振る（wave）: 片手を上げて何回か振る（お辞儀はしない）
 * - うなずく（nod）: 首を縦に1〜2回振る（短い。たくさん届く出来事に当てる）
 * - 大喜び（cheer）: 両手を上げて揺らし、少し反ってにっこりする
 * どちらの手で何回振るか・お辞儀の深さ・うなずく回数は種と反応の種類だけから決め（createVrmPlan）、その時刻の場面（骨ごとの回転・表情）は
 * 現在時刻と、流している反応の経過時間だけから求める（vrmSceneAt。フレーム間の状態を持たない）。
 * 口は読み上げに合わせて開け閉めする。読み上げのページが配った「鳴らしはじめた時刻と区切りごとの音量の列」（src/speech/level.ts）から、
 * その時刻の音量を引いて口の開きにする（口の形は合わせず、音量で開け閉めするだけ）。
 *
 * 骨の回転は VRM の正規化された骨（three-vrm の normalized bone）に当てる値で、どの骨も初期の姿勢（T ポーズ）では回転 0 である。
 * キャラクターはカメラのほう（+Z）を向き、キャラクターの左手は +X 側にある。そのため
 * - 腕を下ろすには、右腕は Z 軸まわりに +、左腕は − に回す（ARM_REST_Z）。上げるのはその逆向き
 * - 前へ曲げる（お辞儀）のは X 軸まわりの + の回転、後ろへ反らすのは − である
 * - 首を横へ向けるのは Y 軸まわりの回転である
 *
 * 注意: 乱数は src/core/background.ts の createRandom だけを使い、Math.random を使わない（同じ種・時刻から同じ姿を再現するため）。
 * 注意: DOM も three.js も読み込まない（描画は view.ts が受け持つ）。髪や服の揺れ（SpringBone）は時刻だけから決められないので、ここでは扱わない。
 */
import { createRandom } from '../core/background'
import type { SpeechLevels } from '../speech/level'
import type { VrmReactionKind } from './call'

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

/** 手の左右（キャラクター自身の左右） */
export type VrmSide = 'left' | 'right'

/** 種と反応の種類から決めた1回ぶんの反応の動き方 */
export interface VrmPlan {
  /** 反応の種類 */
  readonly reaction: VrmReactionKind
  /** どちらの手で振るか（キャラクター自身の左右） */
  readonly wavingHand: VrmSide
  /** 手を振る回数（往復の数） */
  readonly waveCount: number
  /** お辞儀の深さ（1 で既定の深さ） */
  readonly bowDepth: number
  /** うなずく回数 */
  readonly nodCount: number
  /** お辞儀を始める時刻（反応を流しはじめてから。ミリ秒）。お辞儀をしない反応では反応全体の長さと同じ */
  readonly bowStartMs: number
  /** 反応全体の長さ（ミリ秒）。これを過ぎたら待機に戻る */
  readonly totalMs: number
}

/** 流している反応と、流しはじめてからの経過時間 */
export interface VrmReaction {
  readonly plan: VrmPlan
  /** 流しはじめてからの経過時間（ミリ秒） */
  readonly elapsedMs: number
}

export type VrmPhase = 'idle' | 'wave' | 'bow' | 'nod' | 'cheer'

/** その時刻の場面 */
export interface VrmScene {
  readonly phase: VrmPhase
  /** にっこりの表情の強さ（0〜1） */
  readonly happy: number
  /** 瞬きの表情の強さ（0〜1。1 で目を閉じている） */
  readonly blink: number
  /** 口の開き（0〜1。読み上げの音量） */
  readonly mouth: number
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

/** 腕を上げる・下ろす長さと、1往復振る長さ（ミリ秒） */
const RAISE_MS = 400
const WAVE_CYCLE_MS = 600
/** お辞儀で頭を下げる・下げたまま止める・戻す長さ（ミリ秒） */
const BOW_DOWN_MS = 600
const BOW_HOLD_MS = 500
const BOW_UP_MS = 600
/** 手を下ろしてからお辞儀を始めるまでの間（ミリ秒） */
const BOW_GAP_MS = 200

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

/** うなずく回数の下限と上限と、1回の長さ（ミリ秒）。首と頭を前へ倒す大きさ（ラジアン） */
const MIN_NODS = 1
const MAX_NODS = 2
const NOD_MS = 500
const NOD_NECK = 0.18
const NOD_HEAD = 0.12
/** 大喜びで両手を上げたまま揺らす長さ（ミリ秒）と、上腕を上げきった回転・前腕の曲げ・揺らす振れ幅と周期・体を反らす大きさ（ラジアン。右手の向き） */
const CHEER_HOLD_MS = 1400
const CHEER_ARM_Z = 1.1
const CHEER_FOREARM_Z = 0.3
const CHEER_SHAKE = 0.25
const CHEER_SHAKE_MS = 350
const CHEER_LEAN = 0.08

/** 待機の動きの種。マスコットは1体だけなので固定にする（どの合成ページでも同じ時刻には同じ姿になる） */
const IDLE_SEED = 359
/** 呼吸1回の長さ（ミリ秒）と、息を吸うときに胸・背中を反らす大きさ（ラジアン）、腕が開く大きさ（ラジアン） */
const BREATH_MS = 4200
const BREATH_CHEST = 0.03
const BREATH_SPINE = 0.015
const BREATH_ARM = 0.02
/** 瞬きの区切りの長さ（ミリ秒）。区切りごとに1回、種と区切りの番号から決めた時刻に瞬く */
export const BLINK_SLOT_MS = 3500
/** 瞬きで目を閉じきるまでの長さと、開ききるまでの長さ（ミリ秒） */
const BLINK_CLOSE_MS = 60
const BLINK_OPEN_MS = 100
/** 視線のゆらぎ（首と頭を向ける）の、ゆっくりした波と速い波の周期（ミリ秒）と振れ幅（ラジアン） */
const GAZE_SLOW_MS = 9100
const GAZE_FAST_MS = 3700
const GAZE_YAW = 0.12
const GAZE_PITCH = 0.04
/** 呼吸に合わせて体の重心をわずかに左右へ傾ける大きさ（ラジアン）と周期（ミリ秒） */
const SWAY_ROLL = 0.015
const SWAY_MS = 7300
/** 区切りの番号を種に混ぜるときの掛け数（32ビットの黄金比。番号が隣り合っても種が離れるようにする） */
const SLOT_MIX = 0x9e3779b9

const ZERO: BoneRotation = { x: 0, y: 0, z: 0 }

/** 0〜1 の進み具合を、はじめと終わりをなだらかにした進み具合にする */
const smooth = (progress: number): number => {
  const clamped = Math.min(1, Math.max(0, progress))
  return clamped * clamped * (3 - 2 * clamped)
}

/** 下限から上限までの値を、0〜1 の乱数で選ぶ */
const between = (random: () => number, min: number, max: number): number => min + (max - min) * random()

/** 周期の波（−1〜1）。位相は 0〜1 で与える */
const wave = (timeMs: number, periodMs: number, phase: number): number => Math.sin(2 * Math.PI * (timeMs / periodMs + phase))

/** 骨の回転に、別の回転を足す */
const add = (base: BoneRotation, delta: Partial<BoneRotation>): BoneRotation => ({
  x: base.x + (delta.x ?? 0),
  y: base.y + (delta.y ?? 0),
  z: base.z + (delta.z ?? 0),
})

/** 待機の動きの位相（種だけから決まる。毎コマ作り直しても同じ値になる） */
const idlePhases = (() => {
  const random = createRandom(IDLE_SEED)
  return { breath: random(), gazeSlow: random(), gazeFast: random(), pitch: random(), sway: random() }
})()

/** 反応の種類ごとの長さ（お辞儀を始める時刻と全体の長さ。ミリ秒） */
const durationOf = (reaction: VrmReactionKind, waveCount: number, nodCount: number): { bowStartMs: number; totalMs: number } => {
  const waveMs = RAISE_MS + waveCount * WAVE_CYCLE_MS + RAISE_MS
  switch (reaction) {
    case 'thanks': {
      const bowStartMs = waveMs + BOW_GAP_MS
      return { bowStartMs, totalMs: bowStartMs + BOW_DOWN_MS + BOW_HOLD_MS + BOW_UP_MS }
    }
    case 'wave':
      return { bowStartMs: waveMs, totalMs: waveMs }
    case 'nod':
      return { bowStartMs: nodCount * NOD_MS, totalMs: nodCount * NOD_MS }
    case 'cheer': {
      const cheerMs = RAISE_MS + CHEER_HOLD_MS + RAISE_MS
      return { bowStartMs: cheerMs, totalMs: cheerMs }
    }
  }
}

/**
 * 種と反応の種類から1回ぶんの反応の動き方を決める。
 *
 * @param seed 0 以上 2^32 未満の整数（Worker が押し出す呼び出しの種）
 * @param reaction 反応の種類（トリガーの項目から Worker が決めたもの）
 */
export const createVrmPlan = (seed: number, reaction: VrmReactionKind): VrmPlan => {
  const random = createRandom(seed)
  const wavingHand: VrmSide = random() < 0.5 ? 'left' : 'right'
  const waveCount = MIN_WAVES + Math.floor(random() * (MAX_WAVES - MIN_WAVES + 1))
  const bowDepth = between(random, MIN_BOW_DEPTH, MAX_BOW_DEPTH)
  const nodCount = MIN_NODS + Math.floor(random() * (MAX_NODS - MIN_NODS + 1))
  return { reaction, wavingHand, waveCount, bowDepth, nodCount, ...durationOf(reaction, waveCount, nodCount) }
}

/**
 * その時刻の瞬きの強さ。区切り（BLINK_SLOT_MS）ごとに1回、種と区切りの番号から決めた時刻に目を閉じて開ける。
 * 区切りの番号から毎回求め直すので、前のコマの状態を持たない。
 */
const blinkAt = (timeMs: number): number => {
  const slot = Math.floor(timeMs / BLINK_SLOT_MS)
  const blinkMs = BLINK_CLOSE_MS + BLINK_OPEN_MS
  // 瞬きが区切りの境目をまたがないよう、始める時刻は区切りの長さから瞬きの長さを引いた範囲で選ぶ
  const startMs = createRandom((IDLE_SEED + Math.imul(slot, SLOT_MIX)) >>> 0)() * (BLINK_SLOT_MS - blinkMs)
  const sinceStart = timeMs - slot * BLINK_SLOT_MS - startMs
  if (sinceStart < 0 || sinceStart >= blinkMs) return 0
  return sinceStart < BLINK_CLOSE_MS ? sinceStart / BLINK_CLOSE_MS : 1 - (sinceStart - BLINK_CLOSE_MS) / BLINK_OPEN_MS
}

/**
 * 待機の姿勢（腕を下ろして立ち、呼吸と視線のゆらぎを加えた姿勢）の骨の回転。
 *
 * @param timeMs 現在時刻（ミリ秒）
 */
const idleBones = (timeMs: number): Record<VrmBone, BoneRotation> => {
  const bones = Object.fromEntries(VRM_BONES.map((bone) => [bone, ZERO])) as Record<VrmBone, BoneRotation>
  // 息を吸うと胸と背中がわずかに反り（− の回転）、腕が少し開く
  const breath = (wave(timeMs, BREATH_MS, idlePhases.breath) + 1) / 2
  bones.spine = { x: -BREATH_SPINE * breath, y: 0, z: 0 }
  bones.chest = { x: -BREATH_CHEST * breath, y: 0, z: 0 }
  bones.rightUpperArm = { x: 0, y: 0, z: ARM_REST_Z - BREATH_ARM * breath }
  bones.leftUpperArm = { x: 0, y: 0, z: -(ARM_REST_Z - BREATH_ARM * breath) }
  bones.hips = { x: 0, y: 0, z: SWAY_ROLL * wave(timeMs, SWAY_MS, idlePhases.sway) }
  // 視線はゆっくりした波と速い波を重ね、首と頭に分けて向ける（首だけで向くと不自然に見えるため）
  const yaw = GAZE_YAW * (0.7 * wave(timeMs, GAZE_SLOW_MS, idlePhases.gazeSlow) + 0.3 * wave(timeMs, GAZE_FAST_MS, idlePhases.gazeFast))
  const pitch = GAZE_PITCH * wave(timeMs, GAZE_SLOW_MS * 0.7, idlePhases.pitch)
  bones.neck = { x: pitch / 2, y: yaw / 3, z: 0 }
  bones.head = { x: pitch / 2, y: (yaw * 2) / 3, z: 0 }
  return bones
}

/**
 * 手を振る姿勢を重ねる。振る側の腕は待機の姿勢から振り上げる姿勢へ移し、首のかしげは待機の向きに足す。
 *
 * @param waveMs 反応を流しはじめてからの経過時間（ミリ秒）
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
  const upperArm = plan.wavingHand === 'right' ? 'rightUpperArm' : 'leftUpperArm'
  const lowerArm = plan.wavingHand === 'right' ? 'rightLowerArm' : 'leftLowerArm'
  const restZ = mirror * bones[upperArm].z
  const upperZ = restZ + (-ARM_RAISED_Z - restZ) * raise
  const lowerZ = -FOREARM_UP_Z * raise + WAVE_SWING * swing
  bones[upperArm] = { x: 0, y: 0, z: mirror * upperZ }
  // 鏡写しで 0 が −0 にならないよう、+ 0 で正の 0 にそろえる（待機の姿勢と同じ値になるように）
  bones[lowerArm] = { x: 0, y: 0, z: mirror * lowerZ + 0 }
  bones.head = add(bones.head, { z: mirror * HEAD_TILT * swing })
  return raise
}

/**
 * お辞儀の姿勢を重ねる（待機の呼吸の反りに、前への曲げを足す）。
 *
 * @param bowMs お辞儀を始めてからの経過時間（ミリ秒）
 */
const applyBow = (bones: Record<VrmBone, BoneRotation>, plan: VrmPlan, bowMs: number): void => {
  const down = smooth(bowMs / BOW_DOWN_MS)
  const up = smooth((bowMs - BOW_DOWN_MS - BOW_HOLD_MS) / BOW_UP_MS)
  const bend = (down - up) * plan.bowDepth
  bones.spine = add(bones.spine, { x: BOW_SPINE * bend })
  bones.chest = add(bones.chest, { x: BOW_CHEST * bend })
  bones.neck = add(bones.neck, { x: BOW_NECK * bend })
}

/**
 * うなずく姿勢を重ねる。1回ごとに首と頭を前へ倒して戻す（待機の向きに足す）。
 *
 * @param nodMs 反応を流しはじめてからの経過時間（ミリ秒）
 */
const applyNod = (bones: Record<VrmBone, BoneRotation>, nodMs: number): void => {
  // 1回の中で 0 → 1 → 0 と動く（1回の始まりと終わりで首がまっすぐに戻る）
  const dip = (1 - Math.cos((2 * Math.PI * nodMs) / NOD_MS)) / 2
  bones.neck = add(bones.neck, { x: NOD_NECK * dip })
  bones.head = add(bones.head, { x: NOD_HEAD * dip })
}

/**
 * 大喜びの姿勢を重ねる。両腕を待機の姿勢から上げて揺らし、体を少し反らす。
 *
 * @param cheerMs 反応を流しはじめてからの経過時間（ミリ秒）
 * @returns 腕の上がり具合（0〜1。表情の強さにも使う）
 */
const applyCheer = (bones: Record<VrmBone, BoneRotation>, cheerMs: number): number => {
  const raise = smooth(cheerMs / RAISE_MS) * (1 - smooth((cheerMs - RAISE_MS - CHEER_HOLD_MS) / RAISE_MS))
  const shake = CHEER_SHAKE * raise * Math.sin((2 * Math.PI * cheerMs) / CHEER_SHAKE_MS)
  // 右腕で計算し、左腕は Z 軸まわりの回転を反転する（体の左右で鏡写しになるため）
  for (const [upperArm, lowerArm, mirror] of [
    ['rightUpperArm', 'rightLowerArm', 1],
    ['leftUpperArm', 'leftLowerArm', -1],
  ] as const) {
    const restZ = mirror * bones[upperArm].z
    bones[upperArm] = { x: 0, y: 0, z: mirror * (restZ + (-CHEER_ARM_Z - restZ) * raise) }
    // 鏡写しで 0 が −0 にならないよう、+ 0 で正の 0 にそろえる（待機の姿勢と同じ値になるように）
    bones[lowerArm] = { x: 0, y: 0, z: mirror * (-CHEER_FOREARM_Z * raise + shake) + 0 }
  }
  bones.spine = add(bones.spine, { x: -CHEER_LEAN * raise })
  return raise
}

/**
 * その時刻の口の開き。鳴らしはじめてからの時間に当たる区切りの前後の音量を、なめらかにつなぐ。
 *
 * @returns 0〜1。読み上げが無い・鳴らしはじめる前・鳴り終えたあとは 0
 */
const mouthAt = (timeMs: number, speech: SpeechLevels | null): number => {
  if (speech === null) return 0
  const position = (timeMs - speech.startedAt) / speech.frameMs
  if (position < 0 || position >= speech.levels.length) return 0
  const frame = Math.floor(position)
  const current = speech.levels[frame] ?? 0
  const next = speech.levels[frame + 1] ?? 0
  return current + (next - current) * (position - frame)
}

/**
 * 現在時刻と流している反応・読み上げから、その時刻の場面を求める。
 *
 * @param timeMs 現在時刻（ミリ秒。待機の動きと口の開きはこれから決まる）
 * @param reaction 流している反応。流していなければ null。経過時間が反応の長さを過ぎていれば待機として扱う
 * @param speech 鳴っている読み上げの音量の列。鳴っていなければ null
 */
export const vrmSceneAt = (timeMs: number, reaction: VrmReaction | null, speech: SpeechLevels | null): VrmScene => {
  const bones = idleBones(timeMs)
  const blink = blinkAt(timeMs)
  const mouth = mouthAt(timeMs, speech)
  if (reaction === null || reaction.elapsedMs >= reaction.plan.totalMs) return { phase: 'idle', happy: 0, blink, mouth, bones }

  const { plan, elapsedMs } = reaction
  if (plan.reaction === 'nod') {
    applyNod(bones, elapsedMs)
    return { phase: 'nod', happy: 0, blink, mouth, bones }
  }
  if (plan.reaction === 'cheer') {
    const raise = applyCheer(bones, elapsedMs)
    return { phase: 'cheer', happy: raise, blink, mouth, bones }
  }
  // お礼と手を振るは、手を振ってから（お礼だけ）お辞儀する。手を振るだけの反応は bowStartMs が全体の長さと同じなので、お辞儀に入らない
  if (elapsedMs < plan.bowStartMs) {
    const raise = applyWave(bones, plan, elapsedMs)
    return { phase: 'wave', happy: raise, blink, mouth, bones }
  }

  applyBow(bones, plan, elapsedMs - plan.bowStartMs)
  // にっこりはお辞儀を戻しながら消していく（待機へ戻ったときに表情が飛ばないように）
  const happy = 1 - smooth((elapsedMs - plan.bowStartMs - BOW_DOWN_MS - BOW_HOLD_MS) / BOW_UP_MS)
  return { phase: 'bow', happy, blink, mouth, bones }
}
