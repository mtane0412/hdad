/**
 * 手足の置き場所から人形の姿勢を解く
 *
 * 1. 両手の中点と両足の中点から体の向き（足から手へ）を決める。手を足の真上に寄せると向きが決まらないので、始めに向いていた向きを少し混ぜる
 * 2. 肩の中点を手の少し後ろ、脚の付け根の中点を足の少し前に置き、その中点を胴の中心にする
 * 3. 肩と脚の付け根の高さは、手足が届く高さのうち低いほうに合わせる（どちらの手足も伸びきらずに届くように）
 * 4. 胴の長さが変わらないよう、高さの差から胴の水平の長さを決める
 * 5. 肘・膝は二関節の IK で曲げる。肘は後ろ外へ、膝は前上へ曲げる（ひじ・ひざがマットに着いて負けにならないように）
 *
 * 届かない位置を指された手足は、伸びきった位置で止まる（指された円の上に浮かない）。
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
/** 高さを決め直す回数（胴の位置と高さは互いに影響するので、2回で落ち着かせる） */
const HEIGHT_PASSES = 2
/** 肘・膝を曲げる向きの混ぜ方（後ろ・横・上の重み） */
const ELBOW_BACK = 1
const ELBOW_OUT = 0.6
const ELBOW_UP = 0.3
const KNEE_FORWARD = 1
const KNEE_OUT = 0.3
const KNEE_UP = 0.4

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
 * @returns 中間の関節と先の位置。先は届かなければ伸びきった位置になる
 */
export const solveTwoBone = (root: Vec3, target: Vec3, upper: number, lower: number, pole: Vec3): { middle: Vec3; end: Vec3 } => {
  const toTarget = sub(target, root)
  const dir = normalize(toTarget, anyPerpendicular(pole))
  // 届かない・近すぎるときは、骨の長さで作れる範囲に収める（伸びきり・折りたたみ）
  const reach = Math.min(Math.max(length(toTarget), Math.abs(upper - lower) + 1e-4), upper + lower - 1e-9)
  // 余弦定理で、付け根での曲げの角度を求める
  const cosAngle = Math.min(1, Math.max(-1, (upper * upper + reach * reach - lower * lower) / (2 * upper * reach)))
  const sinAngle = Math.sqrt(1 - cosAngle * cosAngle)
  const bend = normalize(sub(pole, scale(dir, dot(pole, dir))), anyPerpendicular(dir))
  return {
    middle: add(add(root, scale(dir, upper * cosAngle)), scale(bend, upper * sinAngle)),
    end: add(root, scale(dir, reach)),
  }
}

/**
 * 付け根を置ける高さのうち、2本の手足がどちらも届く高さ。
 *
 * 手足を伸ばしきらない長さ（REACH_RATIO）で、水平の距離から届く高さを求め、低いほうを採る。
 * 水平の距離だけで届かないときは下限の高さにする（その手足は伸びきって先が円から離れる）。
 */
const reachableHeight = (roots: readonly [Vec3, Vec3], tips: readonly [Vec3, Vec3], limbLength: number, minHeight: number): number => {
  const reach = limbLength * REACH_RATIO
  const heights = roots.map((root, index) => {
    const tip = tips[index] ?? root
    const run = length(sub(flat(tip), flat(root)))
    return tip.y + Math.sqrt(Math.max(reach * reach - run * run, 0))
  })
  return Math.min(Math.max(Math.min(...heights), minHeight), reach)
}

/**
 * 手足の先の位置から、人形1人の姿勢を解く。
 *
 * @param facing 始めに向いていた向き（手を足の真上に寄せても体の向きが決まるよう少し混ぜる）
 */
export const solvePose = (contacts: Contacts, facing: Vec3): Pose => {
  const hands = flat(midpoint(contacts.handL, contacts.handR))
  const feet = flat(midpoint(contacts.footL, contacts.footR))
  const forward = normalize(add(normalize(sub(hands, feet), facing), scale(facing, FACING_BIAS)), facing)
  const right = cross(forward, UP)
  const center = midpoint(sub(hands, scale(forward, SHOULDER_BEHIND_HANDS)), add(feet, scale(forward, HIP_AHEAD_OF_FEET)))
  const armLength = LIMB_CHAINS.handL.upper + LIMB_CHAINS.handL.lower
  const legLength = LIMB_CHAINS.footL.upper + LIMB_CHAINS.footL.lower
  const maxRise = Math.sqrt(TORSO * TORSO - MIN_TORSO_RUN * MIN_TORSO_RUN)

  // 胴の水平の位置と、肩・脚の付け根の高さは互いに影響するので、交互に決め直す
  let shoulderHeight = MIN_SHOULDER_HEIGHT
  let hipHeight = MIN_HIP_HEIGHT
  for (let pass = 0; pass < HEIGHT_PASSES; pass += 1) {
    const rise = Math.min(Math.max(shoulderHeight - hipHeight, -maxRise), maxRise)
    const run = Math.sqrt(TORSO * TORSO - rise * rise)
    const neckFlat = add(center, scale(forward, run / 2))
    const pelvisFlat = sub(center, scale(forward, run / 2))
    shoulderHeight = reachableHeight(
      [sub(neckFlat, scale(right, SHOULDER_HALF)), add(neckFlat, scale(right, SHOULDER_HALF))],
      [contacts.handL, contacts.handR],
      armLength,
      MIN_SHOULDER_HEIGHT,
    )
    hipHeight = reachableHeight(
      [sub(pelvisFlat, scale(right, HIP_HALF)), add(pelvisFlat, scale(right, HIP_HALF))],
      [contacts.footL, contacts.footR],
      legLength,
      MIN_HIP_HEIGHT,
    )
  }
  // 決め直した高さで、胴の長さがちょうどになるよう水平の位置を置き直す
  shoulderHeight = hipHeight + Math.min(Math.max(shoulderHeight - hipHeight, -maxRise), maxRise)
  const run = Math.sqrt(TORSO * TORSO - (shoulderHeight - hipHeight) ** 2)
  const neck = add(add(center, scale(forward, run / 2)), scale(UP, shoulderHeight))
  const pelvis = add(sub(center, scale(forward, run / 2)), scale(UP, hipHeight))

  const joints: Partial<Record<Joint, Vec3>> = {
    neck,
    pelvis,
    head: add(add(neck, scale(forward, HEAD_FORWARD)), scale(UP, HEAD_UP)),
    shoulderL: sub(neck, scale(right, SHOULDER_HALF)),
    shoulderR: add(neck, scale(right, SHOULDER_HALF)),
    hipL: sub(pelvis, scale(right, HIP_HALF)),
    hipR: add(pelvis, scale(right, HIP_HALF)),
  }
  for (const limb of LIMBS) {
    const chain = LIMB_CHAINS[limb]
    const outward = scale(right, chain.side)
    const pole = chain.arm
      ? add(add(scale(forward, -ELBOW_BACK), scale(outward, ELBOW_OUT)), scale(UP, ELBOW_UP))
      : add(add(scale(forward, KNEE_FORWARD), scale(outward, KNEE_OUT)), scale(UP, KNEE_UP))
    const root = joints[chain.root]
    if (root === undefined) throw new Error(`${chain.root} の位置が決まっていません`)
    const { middle, end } = solveTwoBone(root, contacts[limb], chain.upper, chain.lower, pole)
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
