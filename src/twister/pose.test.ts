/**
 * 人形の姿勢を手足の置き場所から解く処理（pose.ts）のテスト
 *
 * 手足の先をマットの円に置いたとき、胴の位置と高さを決め、肘・膝を二関節の IK で曲げる。
 * 骨の長さは変えず、届く円にはちょうど手足が乗り、届かない円には伸びきった位置で止まる。
 * 両手（両足）の前後や遠さに差があると、肩（脚の付け根）の線を回して傾け、体をひねる（上限の角度まで）。
 */
import { describe, expect, it } from 'vitest'
import { FOREARM, HIP_HALF, JOINT_RADII, JOINTS, LIMB_CHAINS, LIMBS, LOSING_JOINTS, SHIN, SHOULDER_HALF, THIGH, TORSO, UPPER_ARM, type Limb, type Pose } from './body'
import { spotPosition } from './mat'
import { INITIAL_SPOTS, PLAYER_FACINGS } from './players'
import { CROUCH_HIP_HEIGHT, CROUCH_SHOULDER_HEIGHT, MAX_TWIST_ROLL, MAX_TWIST_YAW, SUPINE_HIP_HEIGHT, contactsOf, solvePose, type Contacts } from './pose'
import { add, distance, lerp, sub, vec, type Vec3 } from './vec'

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

  it('手足の先を付け根のすぐ近くへ寄せても、付け根と先は物理が許す距離（minSpan）より近づかない', () => {
    // 手を肩のすぐ横へ持ち上げる（運ぶ途中の手が肩の近くを通る場面）。物理（physics.ts）は肩と手を minSpan より近づけないので、
    // IK も同じ距離で止めないと、目標の姿勢と押し出した姿勢が食い違う
    const pose = solvePose(raiderContacts, PLAYER_FACINGS[0])
    for (const limb of LIMBS) {
      const chain = LIMB_CHAINS[limb]
      const nearRoot = add(pose[chain.root], vec(0.02, -0.02, 0))
      const folded = solvePose({ ...raiderContacts, [limb]: nearRoot }, PLAYER_FACINGS[0])
      expect(distance(folded[chain.root], folded[limb]), limb).toBeGreaterThanOrEqual(chain.minSpan - 1e-6)
    }
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

describe('solvePose で伏せる', () => {
  it('伏せる度合いが 0 なら、ふつうに解いた姿勢と同じになる', () => {
    expect(solvePose(raiderContacts, PLAYER_FACINGS[0], { crouch: 0 })).toEqual(solvePose(raiderContacts, PLAYER_FACINGS[0]))
  })

  it('伏せきると、首と腰は伏せた高さまで下がり、手足はそのまま円に届く', () => {
    const pose = solvePose(raiderContacts, PLAYER_FACINGS[0], { crouch: 1 })
    expect(pose.neck.y).toBeLessThanOrEqual(CROUCH_SHOULDER_HEIGHT + 1e-6)
    expect(pose.pelvis.y).toBeLessThanOrEqual(CROUCH_HIP_HEIGHT + 1e-6)
    expect(distance(pose.neck, pose.pelvis)).toBeCloseTo(TORSO, 6)
    for (const limb of LIMBS) {
      expect(distance(pose[limb], raiderContacts[limb]), limb).toBeLessThan(1e-6)
    }
  })

  it('伏せる度合いを上げるほど、胴は低くなる（度合いに応じて少しずつ下がる）', () => {
    const heights = [0, 0.25, 0.5, 0.75, 1].map((crouch) => solvePose(raiderContacts, PLAYER_FACINGS[0], { crouch }).neck.y)
    for (let index = 1; index < heights.length; index += 1) {
      expect(heights[index]).toBeLessThanOrEqual((heights[index - 1] ?? 0) + 1e-9)
    }
    expect(heights[heights.length - 1]).toBeLessThan((heights[0] ?? 0) - 0.1)
  })
})

describe('solvePose で仰向けに裏返る', () => {
  /**
   * 右手を背中の向こう側（青の列）へ回した置き場所。0番は +z を向き、うつ伏せでは右が x の負の側、
   * 仰向けでは右が x の正の側になるので、右手は仰向けの右側に来る
   */
  const flipped: Contacts = contactsOf({ ...INITIAL_SPOTS[0], handR: { color: 'blue', row: 2 } })
  /** 左肩から右肩への線と、腰から首への背骨の外積の高さの成分。うつ伏せでは負（背中が上）、仰向けでは正（腹が上） */
  const bellyUpOf = (pose: Pose): number => {
    const across = sub(pose.shoulderR, pose.shoulderL)
    const spine = sub(pose.neck, pose.pelvis)
    return spine.z * across.x - spine.x * across.z
  }
  /**
   * 裏返る度合いを 0 から 1 まで細かく刻んだ姿勢（右側が上がる向きに回す）。
   * 対戦と同じく、右手は裏返る度合いに合わせて始めの円（黄）から青の円へ、持ち上げながら運ぶ
   */
  const steps = Array.from({ length: 21 }, (_, index) => index / 20)
  const rolling = steps.map((supine) => {
    const handR = add(lerp(raiderContacts.handR, flipped.handR, supine), vec(0, 0.25 * Math.sin(Math.PI * supine), 0))
    return solvePose({ ...flipped, handR }, PLAYER_FACINGS[0], { supine, rollSide: 1 })
  })

  it('裏返る度合いが 0 なら、ふつうに解いた姿勢と同じになる', () => {
    expect(solvePose(flipped, PLAYER_FACINGS[0], { supine: 0, rollSide: 1 })).toEqual(solvePose(flipped, PLAYER_FACINGS[0]))
  })

  it('仰向けでは腹が上を向き、人形の右肩は x の正の側に来る', () => {
    const prone = solvePose(flipped, PLAYER_FACINGS[0])
    const supine = solvePose(flipped, PLAYER_FACINGS[0], { supine: 1, rollSide: 1 })
    expect(bellyUpOf(prone)).toBeLessThan(0)
    expect(bellyUpOf(supine)).toBeGreaterThan(0)
    expect(supine.shoulderR.x).toBeGreaterThan(supine.shoulderL.x)
  })

  it('仰向けでも手足は円に届き、膝はうつ伏せとは逆の足の側へ曲がる（ブリッジ）', () => {
    const pose = solvePose(flipped, PLAYER_FACINGS[0], { supine: 1, rollSide: 1 })
    for (const limb of LIMBS) {
      expect(distance(pose[limb], flipped[limb]), limb).toBeLessThan(0.01)
    }
    // 0番の前は +z なので、足の側は z の負の側
    expect(pose.kneeL.z - pose.hipL.z).toBeLessThan(-0.15)
    expect(pose.kneeR.z - pose.hipR.z).toBeLessThan(-0.15)
    expect(pose.pelvis.y).toBeLessThanOrEqual(SUPINE_HIP_HEIGHT + 1e-6)
  })

  it('裏返る途中も、骨の長さ・肩幅・腰幅・胴の長さ・頭の付き方は変わらない', () => {
    const headReach = distance(rolling[0]?.head ?? vec(0, 0, 0), rolling[0]?.neck ?? vec(0, 0, 0))
    for (const [index, pose] of rolling.entries()) {
      const label = `裏返る度合い ${steps[index]}`
      expect(distance(pose.shoulderL, pose.elbowL), label).toBeCloseTo(UPPER_ARM, 6)
      expect(distance(pose.hipR, pose.kneeR), label).toBeCloseTo(THIGH, 6)
      expect(distance(pose.shoulderL, pose.shoulderR), label).toBeCloseTo(SHOULDER_HALF * 2, 6)
      expect(distance(pose.hipL, pose.hipR), label).toBeCloseTo(HIP_HALF * 2, 6)
      expect(distance(pose.neck, pose.pelvis), label).toBeCloseTo(TORSO, 6)
      expect(distance(pose.head, pose.neck), label).toBeCloseTo(headReach, 6)
    }
  })

  it('裏返る途中も、手足の先のほかの部位はマットから浮いている（太さに 5cm を足した高さより上）', () => {
    for (const [index, pose] of rolling.entries()) {
      for (const joint of LOSING_JOINTS) {
        expect(pose[joint].y, `裏返る度合い ${steps[index]} の${joint}`).toBeGreaterThanOrEqual(JOINT_RADII[joint] + 0.05 - 1e-6)
      }
    }
  })

  it('裏返る度合いを少しずつ変えると、関節も少しずつ動く（途中で飛ばない）', () => {
    for (let index = 1; index < rolling.length; index += 1) {
      const before = rolling[index - 1]
      const after = rolling[index]
      if (before === undefined || after === undefined) throw new Error('姿勢がありません')
      for (const joint of JOINTS) {
        expect(distance(before[joint], after[joint]), `裏返る度合い ${steps[index]} の${joint}`).toBeLessThan(0.12)
      }
    }
  })

  it('仰向けでも、伏せきれば首と腰は伏せた高さまで下がる（相手の下になったとき）', () => {
    const pose = solvePose(flipped, PLAYER_FACINGS[0], { supine: 1, crouch: 1 })
    expect(pose.neck.y).toBeLessThanOrEqual(CROUCH_SHOULDER_HEIGHT + 1e-6)
    expect(pose.pelvis.y).toBeLessThanOrEqual(CROUCH_HIP_HEIGHT + 1e-6)
  })

  it('半分まで裏返ったとき、回す向きの側の肩が上がる', () => {
    const rightUp = solvePose(flipped, PLAYER_FACINGS[0], { supine: 0.5, rollSide: 1 })
    const leftUp = solvePose(flipped, PLAYER_FACINGS[0], { supine: 0.5, rollSide: -1 })
    expect(rightUp.shoulderR.y).toBeGreaterThan(rightUp.shoulderL.y + 0.2)
    expect(leftUp.shoulderL.y).toBeGreaterThan(leftUp.shoulderR.y + 0.2)
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
