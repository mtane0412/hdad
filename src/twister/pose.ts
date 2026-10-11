/**
 * 手足の置き場所から人形の姿勢を解く
 *
 * 1. 両手の中点と両足の中点から体の向き（足から手へ）を決める。手を足の真上に寄せると向きが決まらないので、始めに向いていた向きを少し混ぜる
 * 2. 肩の中点を手の少し後ろ、脚の付け根の中点を足の少し前に置き、その中点を胴の中心にする
 * 3. 肩の線は、両手の前後の差に合わせて水平に回す（右手が前なら右肩が前へ出る）。脚の付け根の線も両足で同じようにする（体のひねり）
 * 4. 肩と脚の付け根の高さは、左右それぞれの手足が届く高さに合わせ、差があれば線を傾ける（遠いほうの肩が下がる）。
 *    回す角度・傾ける角度には上限（MAX_TWIST_YAW・MAX_TWIST_ROLL）があり、超える分は高さを低いほうに合わせて届かせる
 * 5. 胴の長さが変わらないよう、高さの差から胴の水平の長さを決める
 * 6. 伏せる度合い（crouch）が与えられたら、肩と脚の付け根を伏せた高さ（CROUCH_SHOULDER_HEIGHT・CROUCH_HIP_HEIGHT）へ向けて下げる。
 *    相手が上に重なってきた人が、相手の胴の下へもぐり込むのに使う（game.ts）。下げても手足の先は円に届く
 * 7. 仰向けに裏返った度合い（supine）が与えられたら、人形自身の右を反対にして（仰向けでは左右が入れ替わる）同じように解き、
 *    うつ伏せの解と高さ・傾きを混ぜる。肩と脚の付け根の線は、背骨のまわりに同じ角度（π × 度合い）だけ回す（rollSide の側が上がる）。
 *    回すと低いほうの付け根が下がるので、その分だけ胴を持ち上げる。仰向けでは脚の付け根を SUPINE_HIP_HEIGHT まで下げて膝を立てる（ブリッジ）
 * 8. 肘・膝は二関節の IK で曲げる。うつ伏せでは肘は後ろ外へ、膝は前上へ、仰向けでは肘は頭の側へ、膝は足の側へ曲げる
 *    （ひじ・ひざがマットに着いて負けにならないように）。裏返る途中は横と上へ逃がす
 *
 * 届かない位置を指された手足は、伸びきった位置で止まる（指された円の上に浮かない）。付け根に近すぎる位置を指された手足は、
 * 付け根から body.ts の minSpan だけ離れた位置で止まる（物理が許す折りたたみと合わせる）。
 * 相手の体とのめり込みはここでは扱わない（physics.ts の relaxPoses が押し出す）。
 */
import { HEAD_FORWARD, HEAD_UP, HIP_HALF, JOINT_RADII, LIMB_CHAINS, LIMBS, SHOULDER_HALF, TORSO, poseFrom, type Joint, type Limb, type Pose } from './body'
import { spotPosition, type Spot } from './mat'
import type { Placement } from './players'
import { UP, add, cross, dot, flat, length, midpoint, normalize, scale, sub, vec, type Vec3 } from './vec'

/** 手足ごとの先の位置（マットの円の上なら高さ 0。動かしている途中の手足は浮いている） */
export type Contacts = Readonly<Record<Limb, Vec3>>

/** 体の向きを決めるときに混ぜる、始めの向きの重み（手を足の真上に寄せても向きが決まるように） */
const FACING_BIAS = 0.3
/** 肩の中点を両手の中点からどれだけ後ろに置くか（m） */
const SHOULDER_BEHIND_HANDS = 0.05
/** 脚の付け根の中点を両足の中点からどれだけ前に置くか（m） */
const HIP_AHEAD_OF_FEET = 0.1
/** 手足を伸ばしきらない割合。伸びきった腕・脚は硬く見えるので、少し曲げて届く高さにする */
const REACH_RATIO = 0.88
/** 肩・脚の付け根を下げてよい低さ（m）。これより下げると胴がマットに着いてしまう */
const MIN_SHOULDER_HEIGHT = 0.22
const MIN_HIP_HEIGHT = 0.26
/** 胴の水平の長さの下限（m）。高さの差がこれ以上つくと胴が立ちすぎるので、差を縮める */
const MIN_TORSO_RUN = 0.2
/** 肩と脚の付け根の高さの差の上限（m）。胴の水平の長さが MIN_TORSO_RUN より短くならないようにする */
const MAX_RISE = Math.sqrt(TORSO * TORSO - MIN_TORSO_RUN * MIN_TORSO_RUN)
/** 肩・脚の付け根の線を水平に回してよい角度の上限（ラジアン）。これより大きく回すと胴がねじ切れて見える */
export const MAX_TWIST_YAW = Math.PI / 6
/** 肩・脚の付け根の線を傾けてよい角度の上限（ラジアン） */
export const MAX_TWIST_ROLL = Math.PI / 6
/**
 * 伏せきったときの肩・脚の付け根の中点の高さ（m）。首・腰の太さ（body.ts の JOINT_RADII）に、
 * 体を支えているあいだの浮かせる高さ（physics.ts の STANDING_CLEARANCE）を足した高さより少し上にする
 */
export const CROUCH_SHOULDER_HEIGHT = 0.16
export const CROUCH_HIP_HEIGHT = 0.17
/**
 * 仰向けのときの、脚の付け根の中点の高さの上限（m）。脚が届くいちばん高い位置より下げて、膝を立てたブリッジにする
 */
export const SUPINE_HIP_HEIGHT = 0.45
/** 高さを決め直す回数（胴の位置と高さは互いに影響するので、2回で落ち着かせる） */
const HEIGHT_PASSES = 2
/** 肘・膝を曲げる向きの混ぜ方（後ろ・横・上の重み） */
const ELBOW_BACK = 1
const ELBOW_OUT = 0.6
const ELBOW_UP = 0.3
const KNEE_FORWARD = 1
const KNEE_OUT = 0.3
const KNEE_UP = 0.4
/** 裏返る途中に、肘・膝を横と上へ逃がす重み */
const POLE_SWING_OUT = 1.0
const POLE_SWING_UP = 0.5

/** 円の上に置いた手足の先の位置。先の太さ（半径）だけ浮かせて、マットに埋まらないようにする */
export const restingOn = (spot: Spot, limb: Limb): Vec3 => add(spotPosition(spot), scale(UP, JOINT_RADII[limb]))

/** 置き場所（手足ごとの円）を、手足ごとの位置にする */
export const contactsOf = (placement: Placement): Contacts => ({
  handL: restingOn(placement.handL, 'handL'),
  handR: restingOn(placement.handR, 'handR'),
  footL: restingOn(placement.footL, 'footL'),
  footR: restingOn(placement.footR, 'footR'),
})

/** dir に垂直な向きを1つ返す（曲げる向きが決まらないときに使う） */
const anyPerpendicular = (dir: Vec3): Vec3 => normalize(cross(dir, UP), normalize(cross(dir, vec(1, 0, 0)), vec(0, 0, 1)))

/**
 * 二関節の IK。付け根から先までを、上・下の骨の長さを保って結ぶ。
 *
 * @param pole 中間の関節を曲げる向きの目安（付け根→先の向きに垂直な成分だけを使う）
 * @param minSpan 付け根と先を近づけてよい距離の下限（m）。物理（physics.ts）が許す距離に合わせる
 * @returns 中間の関節と先の位置。先は届かなければ伸びきった位置、近すぎれば付け根から minSpan 離れた位置になる
 */
export const solveTwoBone = (root: Vec3, target: Vec3, upper: number, lower: number, pole: Vec3, minSpan = 0): { middle: Vec3; end: Vec3 } => {
  const toTarget = sub(target, root)
  const dir = normalize(toTarget, anyPerpendicular(pole))
  // 届かない・近すぎるときは、骨の長さと下限で作れる範囲に収める（伸びきり・折りたたみ）
  const reach = Math.min(Math.max(length(toTarget), Math.abs(upper - lower) + 1e-4, minSpan), upper + lower - 1e-9)
  // 余弦定理で、付け根での曲げの角度を求める
  const cosAngle = Math.min(1, Math.max(-1, (upper * upper + reach * reach - lower * lower) / (2 * upper * reach)))
  const sinAngle = Math.sqrt(1 - cosAngle * cosAngle)
  const bend = normalize(sub(pole, scale(dir, dot(pole, dir))), anyPerpendicular(dir))
  return {
    middle: add(add(root, scale(dir, upper * cosAngle)), scale(bend, upper * sinAngle)),
    end: add(root, scale(dir, reach)),
  }
}

const clampAngle = (angle: number, limit: number): number => Math.min(Math.max(angle, -limit), limit)

/**
 * 左右の付け根の線を水平に回す角度（ラジアン）。右の先が前にあるほど正（右の付け根が前へ出る）。
 *
 * 左の先から右の先への線の、前後の差と左右の幅から求め、上限で止める。
 * 左右の幅は向きを見ずに大きさだけを使う。右の先が左の先より左へ交差しても角度が裏返らず、手足を動かす途中で
 * 交差の前後を通っても肩・脚の付け根が飛ばないようにするためである。
 */
const twistYaw = (tipL: Vec3, tipR: Vec3, forward: Vec3, right: Vec3): number => {
  const across = sub(flat(tipR), flat(tipL))
  return clampAngle(Math.atan2(dot(across, forward), Math.abs(dot(across, right))), MAX_TWIST_YAW)
}

/** 付け根の線の、左右の付け根の高さと傾き */
interface SideHeights {
  /** 線の中点の高さ（m） */
  readonly center: number
  /** 線の傾き（ラジアン）。右が高いほど正 */
  readonly roll: number
}

/**
 * 手足を伸ばしきらない長さ（REACH_RATIO）で、付け根から先までの水平の距離から、先に届く付け根の高さを求める。
 * 水平の距離だけで届かないときは先の高さにする（呼び出し側が下限の高さで止め、その手足は伸びきって先が円から離れる）。
 */
const reachHeightOf = (root: Vec3, tip: Vec3, reach: number): number => {
  const run = length(sub(flat(tip), flat(root)))
  return tip.y + Math.sqrt(Math.max(reach * reach - run * run, 0))
}

/**
 * 付け根の線の高さと傾き。左右それぞれの手足が届く高さに合わせ、差があれば線を傾ける。
 *
 * 傾きは上限（MAX_TWIST_ROLL）で止め、そのうえで左右どちらの付け根も届く高さを超えないように中点の高さを決める。
 *
 * @param center 線の中点（水平の位置）
 * @param axis 線の水平の向き（左から右。長さ1）
 * @param half 線の長さの半分（肩幅・腰幅の半分）
 * @param limits 付け根を置いてよい高さの下限と上限（m）
 */
const sideHeightsOf = (
  center: Vec3,
  axis: Vec3,
  half: number,
  tips: readonly [Vec3, Vec3],
  limbLength: number,
  limits: { readonly min: number; readonly max: number },
): SideHeights => {
  const reach = limbLength * REACH_RATIO
  const [tipL, tipR] = tips
  const ceiling = Math.min(reach, limits.max)
  const floor = Math.min(limits.min, ceiling)
  const heightL = Math.min(Math.max(reachHeightOf(sub(center, scale(axis, half)), tipL, reach), floor), ceiling)
  const heightR = Math.min(Math.max(reachHeightOf(add(center, scale(axis, half)), tipR, reach), floor), ceiling)
  const roll = clampAngle(Math.asin(Math.min(Math.max((heightR - heightL) / (2 * half), -1), 1)), MAX_TWIST_ROLL)
  const rise = half * Math.sin(roll)
  return { center: Math.max(Math.min(heightL + rise, heightR - rise), floor), roll }
}

/** 水平の向き axis の線を、roll だけ傾けた向き（長さ1）。右が上がるほど正 */
const tiltedAxis = (axis: Vec3, roll: number): Vec3 => add(scale(axis, Math.cos(roll)), scale(UP, Math.sin(roll)))

/** 姿勢の解き方の調整（伏せる・裏返る） */
export interface Posture {
  /**
   * 伏せる度合い（0〜1）。0 なら手足が届くいちばん高い位置に胴を置き、1 なら伏せた高さまで下げる。
   * あいだの値では、置いてよい高さの上限を手足の長さから伏せた高さへ向けて少しずつ下げる（度合いが変わっても胴が飛ばない）
   */
  readonly crouch?: number
  /**
   * 仰向けに裏返った度合い（0〜1）。0 ならうつ伏せ（四つんばい）、1 なら仰向け（ブリッジ）。
   * あいだの値では、肩と脚の付け根の線を背骨のまわりに同じ角度（π × 度合い）だけ回す
   */
  readonly supine?: number
  /** 裏返るときに上がる側（1 なら右側、-1 なら左側）。裏返りきるまで変えない */
  readonly rollSide?: 1 | -1
}

/** 肩・脚の付け根の線の、高さと傾きと水平の向き（うつ伏せ・仰向けそれぞれで解く） */
interface Frame {
  readonly shoulders: SideHeights
  readonly hips: SideHeights
  /** 肩・脚の付け根の線の、ひねった水平の向き（人形自身の左から右。長さ1） */
  readonly shoulderAxis: Vec3
  readonly hipAxis: Vec3
}

/**
 * 肩・脚の付け根の線の向きと高さを解く。
 *
 * @param right 人形自身の右（水平。うつ伏せでは前向きと上向きの外積、仰向けではその反対）
 */
const solveFrame = (
  contacts: Contacts,
  center: Vec3,
  forward: Vec3,
  right: Vec3,
  shoulderLimits: { readonly min: number; readonly max: number },
  hipLimits: { readonly min: number; readonly max: number },
): Frame => {
  const armLength = LIMB_CHAINS.handL.upper + LIMB_CHAINS.handL.lower
  const legLength = LIMB_CHAINS.footL.upper + LIMB_CHAINS.footL.lower
  // 肩・脚の付け根の線の水平の向き（ひねり）。手足の先の位置だけから決まる
  const yawOf = (angle: number): Vec3 => add(scale(right, Math.cos(angle)), scale(forward, Math.sin(angle)))
  const shoulderAxis = yawOf(twistYaw(contacts.handL, contacts.handR, forward, right))
  const hipAxis = yawOf(twistYaw(contacts.footL, contacts.footR, forward, right))
  // 胴の水平の位置と、肩・脚の付け根の高さは互いに影響するので、交互に決め直す
  let shoulders: SideHeights = { center: Math.min(shoulderLimits.min, shoulderLimits.max), roll: 0 }
  let hips: SideHeights = { center: Math.min(hipLimits.min, hipLimits.max), roll: 0 }
  for (let pass = 0; pass < HEIGHT_PASSES; pass += 1) {
    const rise = Math.min(Math.max(shoulders.center - hips.center, -MAX_RISE), MAX_RISE)
    const run = Math.sqrt(TORSO * TORSO - rise * rise)
    const neckFlat = add(center, scale(forward, run / 2))
    const pelvisFlat = sub(center, scale(forward, run / 2))
    shoulders = sideHeightsOf(neckFlat, shoulderAxis, SHOULDER_HALF, [contacts.handL, contacts.handR], armLength, shoulderLimits)
    hips = sideHeightsOf(pelvisFlat, hipAxis, HIP_HALF, [contacts.footL, contacts.footR], legLength, hipLimits)
  }
  return { shoulders, hips, shoulderAxis, hipAxis }
}

/**
 * 付け根の線の向き（長さ1）。うつ伏せの向きを、前向きの軸のまわりに angle だけ回し（rollSide の側を上げる）、
 * 高さの差による傾き roll を加える。angle が π なら、仰向けで解いた向きと一致する（前向きの成分は回しても変わらない）
 */
const rolledAxis = (proneAxis: Vec3, forward: Vec3, right: Vec3, angle: number, rollSide: 1 | -1, roll: number): Vec3 => {
  const along = dot(proneAxis, forward)
  const across = dot(proneAxis, right)
  const lateral = add(scale(right, Math.cos(angle)), scale(UP, Math.sin(angle) * rollSide))
  const base = add(scale(forward, along), scale(lateral, across))
  // 回した線は上向きの成分を持つので、傾けた後に長さ1へ戻す（肩幅・腰幅を変えない）
  return normalize(tiltedAxis(base, roll), base)
}

/** 2つの数を割合で混ぜる */
const mix = (a: number, b: number, ratio: number): number => a + (b - a) * ratio

/**
 * 手足の先の位置から、人形1人の姿勢を解く。
 *
 * @param facing 始めに向いていた向き（手を足の真上に寄せても体の向きが決まるよう少し混ぜる）
 * @param posture 伏せる度合いと裏返った度合い（省略すれば、うつ伏せで伏せない）
 */
export const solvePose = (contacts: Contacts, facing: Vec3, posture: Posture = {}): Pose => {
  const { crouch = 0, supine = 0, rollSide = 1 } = posture
  const hands = flat(midpoint(contacts.handL, contacts.handR))
  const feet = flat(midpoint(contacts.footL, contacts.footR))
  const forward = normalize(add(normalize(sub(hands, feet), facing), scale(facing, FACING_BIAS)), facing)
  const right = cross(forward, UP)
  const center = midpoint(sub(hands, scale(forward, SHOULDER_BEHIND_HANDS)), add(feet, scale(forward, HIP_AHEAD_OF_FEET)))
  const armLength = LIMB_CHAINS.handL.upper + LIMB_CHAINS.handL.lower
  const legLength = LIMB_CHAINS.footL.upper + LIMB_CHAINS.footL.lower
  const shoulderLimits = { min: MIN_SHOULDER_HEIGHT, max: armLength + (CROUCH_SHOULDER_HEIGHT - armLength) * crouch }
  // 仰向けでは、脚の付け根を SUPINE_HIP_HEIGHT まで下げて膝を立てる（裏返る度合いに応じて少しずつ下げる）
  const hipLimits = {
    min: MIN_HIP_HEIGHT,
    max: Math.min(legLength + (CROUCH_HIP_HEIGHT - legLength) * crouch, legLength + (SUPINE_HIP_HEIGHT - legLength) * supine),
  }

  // うつ伏せと仰向けをそれぞれ解き、高さと傾きは裏返った度合いで混ぜる。線の向きは背骨のまわりに回す
  const prone = solveFrame(contacts, center, forward, right, shoulderLimits, hipLimits)
  const back = supine > 0 ? solveFrame(contacts, center, forward, scale(right, -1), shoulderLimits, hipLimits) : prone
  const angle = Math.PI * supine
  const shoulderDir = rolledAxis(prone.shoulderAxis, forward, right, angle, rollSide, mix(prone.shoulders.roll, back.shoulders.roll, supine))
  const hipDir = rolledAxis(prone.hipAxis, forward, right, angle, rollSide, mix(prone.hips.roll, back.hips.roll, supine))
  // 背骨のまわりに回すと低いほうの付け根が下がるので、回した分だけ中点を持ち上げ、低いほうの付け根も下限の高さに保つ
  // （回していない向きの傾きは解いた高さに含まれているので足さない。裏返りはじめと終わりで高さが飛ばない）
  const liftFor = (axis: Vec3, half: number, limits: { readonly min: number; readonly max: number }): number =>
    Math.min(limits.min, limits.max) + half * Math.abs(Math.sin(angle) * dot(axis, right))
  let shoulderHeight = Math.max(mix(prone.shoulders.center, back.shoulders.center, supine), liftFor(prone.shoulderAxis, SHOULDER_HALF, shoulderLimits))
  const hipHeight = Math.max(mix(prone.hips.center, back.hips.center, supine), liftFor(prone.hipAxis, HIP_HALF, hipLimits))
  // 決め直した高さで、胴の長さがちょうどになるよう水平の位置を置き直す
  shoulderHeight = hipHeight + Math.min(Math.max(shoulderHeight - hipHeight, -MAX_RISE), MAX_RISE)
  const run = Math.sqrt(TORSO * TORSO - (shoulderHeight - hipHeight) ** 2)
  const neck = add(add(center, scale(forward, run / 2)), scale(UP, shoulderHeight))
  const pelvis = add(sub(center, scale(forward, run / 2)), scale(UP, hipHeight))

  const shoulderLine = scale(shoulderDir, SHOULDER_HALF)
  const hipLine = scale(hipDir, HIP_HALF)
  // 頭は、うつ伏せでは首の前上、仰向けでは背骨の延長の少し上に出す（首からの距離は変えない）
  const headOffset = scale(
    normalize(add(scale(forward, mix(HEAD_FORWARD, HEAD_UP, supine)), scale(UP, mix(HEAD_UP, HEAD_FORWARD, supine))), UP),
    Math.hypot(HEAD_FORWARD, HEAD_UP),
  )
  const joints: Partial<Record<Joint, Vec3>> = {
    neck,
    pelvis,
    head: add(neck, headOffset),
    shoulderL: sub(neck, shoulderLine),
    shoulderR: add(neck, shoulderLine),
    hipL: sub(pelvis, hipLine),
    hipR: add(pelvis, hipLine),
  }
  // 肘・膝を曲げる向き。前後（肘はうつ伏せで後ろ・仰向けで頭の側、膝はその逆）と外側は裏返る角度の余弦で入れ替え、
  // 途中は横（POLE_SWING）へ逃がす。前後と外側を直線で混ぜると途中で曲げる向きが消え、肘・膝が飛ぶため
  const turn = Math.cos(angle)
  const swing = Math.sin(angle)
  for (const limb of LIMBS) {
    const chain = LIMB_CHAINS[limb]
    const outward = scale(right, chain.side)
    const pole = chain.arm
      ? add(add(scale(forward, -ELBOW_BACK * turn), scale(outward, (ELBOW_OUT * turn + POLE_SWING_OUT * swing))), scale(UP, ELBOW_UP + POLE_SWING_UP * swing))
      : add(add(scale(forward, KNEE_FORWARD * turn), scale(outward, KNEE_OUT * turn + POLE_SWING_OUT * swing)), scale(UP, KNEE_UP + POLE_SWING_UP * swing))
    const root = joints[chain.root]
    if (root === undefined) throw new Error(`${chain.root} の位置が決まっていません`)
    const { middle, end } = solveTwoBone(root, contacts[limb], chain.upper, chain.lower, pole, chain.minSpan)
    joints[chain.middle] = middle
    joints[limb] = end
  }
  return completePose(joints)
}

/** すべての関節の位置がそろっていることを確かめて姿勢にする */
const completePose = (joints: Partial<Record<Joint, Vec3>>): Pose =>
  poseFrom((joint) => {
    const position = joints[joint]
    if (position === undefined) throw new Error(`姿勢の関節 ${joint} の位置が決まっていません`)
    return position
  })
