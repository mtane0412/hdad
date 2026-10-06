/**
 * 人形の姿勢を手足の置き場所から解く処理（pose.ts）のテスト
 *
 * 手足の先をマットの円に置いたとき、胴の位置と高さを決め、肘・膝を二関節の IK で曲げる。
 * 骨の長さは変えず、届く円にはちょうど手足が乗り、届かない円には伸びきった位置で止まる。
 */
import { describe, expect, it } from 'vitest'
import { FOREARM, JOINT_RADII, LIMB_CHAINS, LIMBS, LOSING_JOINTS, SHIN, THIGH, TORSO, UPPER_ARM, type Limb } from './body'
import { spotPosition } from './mat'
import { INITIAL_SPOTS, PLAYER_FACINGS } from './players'
import { contactsOf, solvePose, type Contacts } from './pose'
import { distance, vec } from './vec'

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

describe('contactsOf', () => {
  it('手足ごとに、置いた円の中心から手足の太さ（半径）だけ上の位置を返す（先がマットに埋まらないように）', () => {
    const contacts = contactsOf(INITIAL_SPOTS[1])
    const limb: Limb = 'footL'
    const center = spotPosition(INITIAL_SPOTS[1][limb])
    expect(contacts[limb]).toEqual(vec(center.x, JOINT_RADII[limb], center.z))
  })
})
