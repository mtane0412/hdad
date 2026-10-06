/**
 * ツイスターの人形の体のつくり（関節・骨・寸法）
 *
 * 人形は関節の位置だけで表す（姿勢 = 関節ごとの位置）。描画は関節のあいだにカプセルを渡し、物理は関節を粒として動かす。
 * 寸法は大人の体をもとにした決め打ちで、マットの円の間隔（mat.ts）は四つんばいの2人が両端に収まるよう、この寸法に合わせてある。
 *
 * 左右は人形自身から見た向き（腹を下にして前を向いたとき、右手は前向きと上向きの外積の側）。
 */
import type { Vec3 } from './vec'

/** 関節の一覧。neck は両肩の中点、pelvis は両脚の付け根の中点にあたる */
export const JOINTS = [
  'head',
  'neck',
  'shoulderL',
  'shoulderR',
  'elbowL',
  'elbowR',
  'handL',
  'handR',
  'pelvis',
  'hipL',
  'hipR',
  'kneeL',
  'kneeR',
  'footL',
  'footR',
] as const
export type Joint = (typeof JOINTS)[number]

/** 姿勢（関節ごとの位置） */
export type Pose = Readonly<Record<Joint, Vec3>>

/** 関節ごとに位置を求めて姿勢を作る */
export const poseFrom = (positionOf: (joint: Joint) => Vec3): Pose => ({
  head: positionOf('head'),
  neck: positionOf('neck'),
  shoulderL: positionOf('shoulderL'),
  shoulderR: positionOf('shoulderR'),
  elbowL: positionOf('elbowL'),
  elbowR: positionOf('elbowR'),
  handL: positionOf('handL'),
  handR: positionOf('handR'),
  pelvis: positionOf('pelvis'),
  hipL: positionOf('hipL'),
  hipR: positionOf('hipR'),
  kneeL: positionOf('kneeL'),
  kneeR: positionOf('kneeR'),
  footL: positionOf('footL'),
  footR: positionOf('footR'),
})

/** マットの円に置く手足 */
export const LIMBS = ['handL', 'handR', 'footL', 'footR'] as const
export type Limb = (typeof LIMBS)[number]

/** 手足の、画面に出す名前（スピナーの区画） */
export const LIMB_LABELS: Readonly<Record<Limb, string>> = {
  handL: '左手',
  handR: '右手',
  footL: '左足',
  footR: '右足',
}

/** 上腕・前腕の長さ（m） */
export const UPPER_ARM = 0.3
export const FOREARM = 0.3
/** 太もも・すねの長さ（m） */
export const THIGH = 0.43
export const SHIN = 0.43
/** 首の付け根（neck）から脚の付け根の中点（pelvis）までの長さ（m） */
export const TORSO = 0.52
/** 肩幅の半分・腰幅の半分（m） */
export const SHOULDER_HALF = 0.18
export const HIP_HALF = 0.11
/** 頭の中心の、首の付け根からの位置（前へ・上へ。m） */
export const HEAD_FORWARD = 0.06
export const HEAD_UP = 0.14

/** 手足ごとの付け根・中間の関節と骨の長さ（二関節の IK に渡す） */
export const LIMB_CHAINS: Readonly<
  Record<Limb, { readonly root: Joint; readonly middle: Joint; readonly upper: number; readonly lower: number; readonly side: 1 | -1; readonly arm: boolean }>
> = {
  handL: { root: 'shoulderL', middle: 'elbowL', upper: UPPER_ARM, lower: FOREARM, side: -1, arm: true },
  handR: { root: 'shoulderR', middle: 'elbowR', upper: UPPER_ARM, lower: FOREARM, side: 1, arm: true },
  footL: { root: 'hipL', middle: 'kneeL', upper: THIGH, lower: SHIN, side: -1, arm: false },
  footR: { root: 'hipR', middle: 'kneeR', upper: THIGH, lower: SHIN, side: 1, arm: false },
}

/** 関節を粒としたときの半径（m）。床と相手の体へのめり込みを防ぐ大きさで、描画の太さとも合わせる */
export const JOINT_RADII: Readonly<Record<Joint, number>> = {
  head: 0.11,
  neck: 0.1,
  shoulderL: 0.07,
  shoulderR: 0.07,
  elbowL: 0.05,
  elbowR: 0.05,
  handL: 0.05,
  handR: 0.05,
  pelvis: 0.11,
  hipL: 0.08,
  hipR: 0.08,
  kneeL: 0.06,
  kneeR: 0.06,
  footL: 0.05,
  footR: 0.05,
}

/**
 * 体の骨（関節のあいだに渡すカプセル）。描画と、相手の体とのぶつかりに使う。
 * 半径は描く太さで、胴は背骨（neck→pelvis）に太いカプセル、体の幅は肩→腰の左右2本で出す。
 */
export const BONES: readonly { readonly from: Joint; readonly to: Joint; readonly radius: number }[] = [
  { from: 'head', to: 'neck', radius: 0.07 },
  { from: 'neck', to: 'pelvis', radius: 0.11 },
  { from: 'shoulderL', to: 'hipL', radius: 0.07 },
  { from: 'shoulderR', to: 'hipR', radius: 0.07 },
  { from: 'shoulderL', to: 'shoulderR', radius: 0.07 },
  { from: 'hipL', to: 'hipR', radius: 0.08 },
  { from: 'shoulderL', to: 'elbowL', radius: 0.05 },
  { from: 'elbowL', to: 'handL', radius: 0.045 },
  { from: 'shoulderR', to: 'elbowR', radius: 0.05 },
  { from: 'elbowR', to: 'handR', radius: 0.045 },
  { from: 'hipL', to: 'kneeL', radius: 0.065 },
  { from: 'kneeL', to: 'footL', radius: 0.055 },
  { from: 'hipR', to: 'kneeR', radius: 0.065 },
  { from: 'kneeR', to: 'footR', radius: 0.055 },
]

/** マットに着いたら負けになる関節（手足の先以外） */
export const LOSING_JOINTS: readonly Joint[] = JOINTS.filter((joint) => !(LIMBS as readonly string[]).includes(joint))

/** 負けになった関節の、結果に出す呼び名 */
export const JOINT_LABELS: Readonly<Record<Joint, string>> = {
  head: '頭',
  neck: '胸',
  shoulderL: '肩',
  shoulderR: '肩',
  elbowL: 'ひじ',
  elbowR: 'ひじ',
  handL: '左手',
  handR: '右手',
  pelvis: 'おしり',
  hipL: 'おしり',
  hipR: 'おしり',
  kneeL: 'ひざ',
  kneeR: 'ひざ',
  footL: '左足',
  footR: '右足',
}
