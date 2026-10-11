/**
 * 人形の姿勢を手足の置き場所から解く処理（pose.ts）のテスト
 *
 * 手足の先をマットの円に置いたとき、胴の位置と高さを決め、肘・膝を二関節の IK で曲げる。
 * 骨の長さは変えず、届く円にはちょうど手足が乗り、届かない円には伸びきった位置で止まる。
 * 両手（両足）の前後や遠さに差があると、肩（脚の付け根）の線を回して傾け、体をひねる（上限の角度まで）。
 */
import { describe, expect, it } from 'vitest'
import { FOREARM, HIP_HALF, JOINT_RADII, LIMB_CHAINS, LIMBS, LOSING_JOINTS, SHIN, SHOULDER_HALF, THIGH, TORSO, UPPER_ARM, type Limb } from './body'
import { spotPosition } from './mat'
import { INITIAL_SPOTS, PLAYER_FACINGS } from './players'
import { MAX_TWIST_ROLL, MAX_TWIST_YAW, contactsOf, solvePose, type Contacts } from './pose'
import { add, distance, sub, vec, type Vec3 } from './vec'

/** レイドした人（0番）の始めの置き場所の位置 */
const raiderContacts: Contacts = contactsOf(INITIAL_SPOTS[0])

describe('solvePose', () => {
  it('届く円に置いた手足は、円の中心にちょうど乗る', () => {
    const pose = solvePose(raiderContacts, PLAYER_FACINGS[0])
    for (const limb of LIMBS) {
      expect(distance(pose[limb], raiderContacts[limb])).toBeLessThan(1e-6)
    }
  })

  it('腕・脚・胴の骨の長さを変えない', () => {
    const pose = solvePose(raiderContacts, PLAYER_FACINGS[0])
    expect(distance(pose.shoulderL, pose.elbowL)).toBeCloseTo(UPPER_ARM, 6)
    expect(distance(pose.elbowL, pose.handL)).toBeCloseTo(FOREARM, 6)
    expect(distance(pose.hipR, pose.kneeR)).toBeCloseTo(THIGH, 6)
    expect(distance(pose.kneeR, pose.footR)).toBeCloseTo(SHIN, 6)
    expect(distance(pose.neck, pose.pelvis)).toBeCloseTo(TORSO, 6)
  })

  it('始めの姿勢では、手足の先のほか（頭・胴・ひざ・ひじ）はマットから浮いている', () => {
    for (const player of [0, 1] as const) {
      const pose = solvePose(contactsOf(INITIAL_SPOTS[player]), PLAYER_FACINGS[player])
      for (const joint of LOSING_JOINTS) {
        expect(pose[joint].y, `${player}番の${joint}`).toBeGreaterThan(0.1)
      }
    }
  })

  it('届かない位置を指された手は、肩から腕の長さだけ伸びきった位置で止まる', () => {
    const farAway: Contacts = { ...raiderContacts, handR: vec(-3, 0, 3) }
    const pose = solvePose(farAway, PLAYER_FACINGS[0])
    const chain = LIMB_CHAINS.handR
    expect(distance(pose[chain.root], pose.handR)).toBeCloseTo(UPPER_ARM + FOREARM, 3)
    expect(distance(pose.handR, farAway.handR)).toBeGreaterThan(1)
  })

  it('手を胸の下へ寄せても、胴の長さは変わらず向きが決まる', () => {
    const tucked: Contacts = { ...raiderContacts, handL: raiderContacts.footL, handR: raiderContacts.footR }
    const pose = solvePose(tucked, PLAYER_FACINGS[0])
    expect(distance(pose.neck, pose.pelvis)).toBeCloseTo(TORSO, 6)
    expect(Number.isFinite(pose.head.x)).toBe(true)
  })
})

describe('solvePose の体のひねり', () => {
  /** レイドした人（0番）は +z を向くので、前は +z */
  const forward = vec(0, 0, 1)
  /** 位置をずらす */
  const shifted = (position: Vec3, offset: Vec3): Vec3 => add(position, offset)
  /** 左から右への線の、前への出っぱり（m） */
  const forwardOf = (left: Vec3, right: Vec3): number => sub(right, left).z * forward.z
  /** 左から右への線の傾きの角度（ラジアン）。右が高いと正 */
  const rollOf = (left: Vec3, right: Vec3, half: number): number => Math.asin((right.y - left.y) / (2 * half))

  it('始めの姿勢では、肩も脚の付け根も水平でまっすぐ並ぶ（ひねらない）', () => {
    const pose = solvePose(raiderContacts, PLAYER_FACINGS[0])
    expect(pose.shoulderL.y).toBeCloseTo(pose.shoulderR.y, 6)
    expect(pose.hipL.y).toBeCloseTo(pose.hipR.y, 6)
    expect(forwardOf(pose.shoulderL, pose.shoulderR)).toBeCloseTo(0, 6)
    expect(forwardOf(pose.hipL, pose.hipR)).toBeCloseTo(0, 6)
  })

  it('右手だけ前へ出すと、右肩が前へ出て下がり、右手は円に届く', () => {
    const contacts: Contacts = { ...raiderContacts, handR: shifted(raiderContacts.handR, vec(0, 0, 0.3)) }
    const pose = solvePose(contacts, PLAYER_FACINGS[0])
    expect(forwardOf(pose.shoulderL, pose.shoulderR)).toBeGreaterThan(0.02)
    expect(pose.shoulderR.y).toBeLessThan(pose.shoulderL.y)
    expect(distance(pose.handR, contacts.handR)).toBeLessThan(0.01)
  })

  it('右足だけ後ろへ引くと、右の脚の付け根が後ろへ下がる', () => {
    const contacts: Contacts = { ...raiderContacts, footR: shifted(raiderContacts.footR, vec(0, 0, -0.3)) }
    const pose = solvePose(contacts, PLAYER_FACINGS[0])
    expect(forwardOf(pose.hipL, pose.hipR)).toBeLessThan(-0.01)
    expect(distance(pose.footR, contacts.footR)).toBeLessThan(0.01)
  })

  it('ひねっても、肩幅・腰幅・胴の長さは変わらない', () => {
    const contacts: Contacts = { ...raiderContacts, handR: shifted(raiderContacts.handR, vec(0, 0, 0.3)), footL: shifted(raiderContacts.footL, vec(0, 0, -0.3)) }
    const pose = solvePose(contacts, PLAYER_FACINGS[0])
    expect(distance(pose.shoulderL, pose.shoulderR)).toBeCloseTo(SHOULDER_HALF * 2, 6)
    expect(distance(pose.hipL, pose.hipR)).toBeCloseTo(HIP_HALF * 2, 6)
    expect(distance(pose.neck, pose.pelvis)).toBeCloseTo(TORSO, 6)
  })

  it('両手の前後の差がどれだけ大きくても、ひねりと傾きは上限の角度で止まる', () => {
    const contacts: Contacts = { ...raiderContacts, handR: shifted(raiderContacts.handR, vec(0, 0, 0.9)) }
    const pose = solvePose(contacts, PLAYER_FACINGS[0])
    const yaw = Math.atan2(forwardOf(pose.shoulderL, pose.shoulderR), Math.hypot(pose.shoulderR.x - pose.shoulderL.x, 0))
    expect(Math.abs(yaw)).toBeLessThanOrEqual(MAX_TWIST_YAW + 1e-6)
    expect(Math.abs(rollOf(pose.shoulderL, pose.shoulderR, SHOULDER_HALF))).toBeLessThanOrEqual(MAX_TWIST_ROLL + 1e-6)
  })

  it('右手を左手より左へ交差させても、両手は円に届き、ひじ・ひざ・胴はマットから浮いている', () => {
    // 0番の右は x の負の側なので、右手を左手（緑の列）よりさらに x の正の側（青の列）へ置くと腕が交差する
    const crossed: Contacts = { ...raiderContacts, handR: contactsOf({ ...INITIAL_SPOTS[0], handR: { color: 'blue', row: 2 } }).handR }
    const pose = solvePose(crossed, PLAYER_FACINGS[0])
    expect(distance(pose.handR, crossed.handR)).toBeLessThan(0.01)
    expect(distance(pose.handL, crossed.handL)).toBeLessThan(0.01)
    for (const joint of LOSING_JOINTS) {
      expect(pose[joint].y, joint).toBeGreaterThan(0.1)
    }
  })
})

describe('contactsOf', () => {
  it('手足ごとに、置いた円の中心から手足の太さ（半径）だけ上の位置を返す（先がマットに埋まらないように）', () => {
    const contacts = contactsOf(INITIAL_SPOTS[1])
    const limb: Limb = 'footL'
    const center = spotPosition(INITIAL_SPOTS[1][limb])
    expect(contacts[limb]).toEqual(vec(center.x, JOINT_RADII[limb], center.z))
  })
})
