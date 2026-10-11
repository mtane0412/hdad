/**
 * 人形の物理（physics.ts）のテスト
 *
 * 物理は関節を粒、骨を長さの決まった棒として動かす（Verlet 積分）。使いみちは2つある。
 * - relaxPoses: 動かしている最中の2人の体のめり込みを押し出す（重力は掛けない。毎フレーム、その時刻の姿勢だけから求める）。
 * - relaxFollowing: 前のコマで押し出し終えた姿勢から続けて押し出す（倒れはじめるまでを記録するときに、1コマずつ使う）。
 *   前のコマから続けて解くので、関節が相手の骨の中心線をまたいでも押す向きが裏返らず、姿勢が飛ばない
 * - bakeCollapse: 最後の指示で倒れ込むところを、始めから終わりまで先に計算して記録する（描画はその記録を経過時間で引くだけ）
 */
import { describe, expect, it } from 'vitest'
import { BONES, JOINT_RADII, JOINTS, LIMBS, LOSING_JOINTS, poseFrom, type Pose } from './body'
import { INITIAL_SPOTS, PLAYER_FACINGS } from './players'
import { COLLAPSE_AFTER_TOUCHDOWN_MS, COLLAPSE_FRAME_MS, STANDING_CLEARANCE, bakeCollapse, collapsePosesAt, recordedPosesAt, relaxFollowing, relaxPoses, type CollapseInput, type Pins, type PosePair } from './physics'
import { contactsOf, solvePose } from './pose'
import { add, distance, distanceToSegment, vec, type Vec3 } from './vec'

/** 2人の始めの姿勢（マットの両端で向かい合う。体は離れている） */
const startPoses = [solvePose(contactsOf(INITIAL_SPOTS[0]), PLAYER_FACINGS[0]), solvePose(contactsOf(INITIAL_SPOTS[1]), PLAYER_FACINGS[1])] as const
/** 2人とも、手足を始めの円に留めた状態 */
const startPins = [contactsOf(INITIAL_SPOTS[0]), contactsOf(INITIAL_SPOTS[1])] as const satisfies readonly [Pins, Pins]

/** 姿勢をまるごと動かす */
const shifted = (pose: Pose, offset: Vec3): Pose => poseFrom((joint) => add(pose[joint], offset))

/** 1人目の関節が、2人目の骨にどれだけめり込んでいるか（いちばん深いところ。めり込んでいなければ 0 以下） */
const deepestPenetration = (a: Pose, b: Pose): number =>
  Math.max(...JOINTS.flatMap((joint) => BONES.map((bone) => JOINT_RADII[joint] + bone.radius - distanceToSegment(a[joint], b[bone.from], b[bone.to]))))

describe('relaxPoses', () => {
  it('体が離れていれば、姿勢をそのまま返す', () => {
    const [raider, streamer] = relaxPoses(startPoses, startPins)
    for (const joint of JOINTS) {
      expect(distance(raider[joint], startPoses[0][joint])).toBeLessThan(1e-9)
      expect(distance(streamer[joint], startPoses[1][joint])).toBeLessThan(1e-9)
    }
  })

  it('手足の先のほかの部位は、マットから少し浮かせておく（体を支えているあいだはマットに着かない）', () => {
    // レイドした人を、マットに沈むほど低くずらす（手足は留めない）
    const sunk = [shifted(startPoses[0], vec(0, -1, 0)), startPoses[1]] as const
    const [raider] = relaxPoses(sunk, [{}, startPins[1]])
    for (const joint of LOSING_JOINTS) {
      expect(raider[joint].y - JOINT_RADII[joint]).toBeGreaterThanOrEqual(STANDING_CLEARANCE - 1e-9)
    }
  })

  it('相手の体にめり込んだ体を押し出し、留めた手足は動かさない', () => {
    // 配信者を、レイドした人と同じ場所に少しずらして重ねる（配信者の手足は留めない）
    const overlapping = [startPoses[0], shifted(startPoses[0], vec(0.05, 0.1, 0))] as const
    const before = deepestPenetration(overlapping[1], overlapping[0])
    const [raider, streamer] = relaxPoses(overlapping, [startPins[0], {}])
    expect(deepestPenetration(streamer, raider)).toBeLessThan(before)
    for (const limb of LIMBS) {
      expect(distance(raider[limb], startPins[0][limb])).toBeLessThan(1e-9)
    }
  })
})

describe('relaxFollowing', () => {
  /** 配信者を、レイドした人の少し上に重ねる（配信者の手足は留めない） */
  const stackedAt = (offsetX: number): PosePair => [startPoses[0], shifted(startPoses[0], vec(offsetX, 0.1, 0))]
  const pins: readonly [Pins, Pins] = [startPins[0], {}]

  it('体が離れていて、前のコマも目標と同じなら、目標をそのまま返す', () => {
    const [raider, streamer] = relaxFollowing(startPoses, startPoses, startPins)
    for (const joint of JOINTS) {
      expect(distance(raider[joint], startPoses[0][joint])).toBeLessThan(1e-9)
      expect(distance(streamer[joint], startPoses[1][joint])).toBeLessThan(1e-9)
    }
  })

  it('体が離れていれば、前のコマの姿勢が目標からずれていても、数コマで目標に追いつく', () => {
    // 前のコマで、配信者が目標から 10cm 横にずれていた
    let previous: PosePair = [startPoses[0], shifted(startPoses[1], vec(0.1, 0, 0))]
    for (let frame = 0; frame < 40; frame += 1) previous = relaxFollowing(previous, startPoses, [startPins[0], {}])
    for (const joint of JOINTS) {
      expect(distance(previous[1][joint], startPoses[1][joint]), joint).toBeLessThan(0.001)
    }
  })

  it('目標が1コマで大きく動いても、留めていない関節は少しずつ追いかける（飛ばない）', () => {
    // 目標の配信者が、1コマで 50cm 横へ動いた（配信者の手足は留めない）
    const jumped: PosePair = [startPoses[0], shifted(startPoses[1], vec(0.5, 0, 0))]
    const [, streamer] = relaxFollowing(startPoses, jumped, [startPins[0], {}])
    for (const joint of JOINTS) {
      expect(distance(streamer[joint], startPoses[1][joint]), joint).toBeLessThan(0.05)
    }
  })

  it('留めた手足は、前のコマの姿勢にかかわらず目標の位置に置く', () => {
    const drifted: PosePair = [shifted(startPoses[0], vec(0, 0, 0.2)), startPoses[1]]
    const [raider] = relaxFollowing(drifted, startPoses, startPins)
    for (const limb of LIMBS) {
      expect(distance(raider[limb], startPins[0][limb])).toBeLessThan(1e-9)
    }
  })

  it('重なる位置を1コマごとに少しずつずらしても、押し出した姿勢は飛ばない（関節が相手の骨の中心線をまたいでも押す向きが裏返らない）', () => {
    // 配信者を、レイドした人の胴の真上を横切るように、1コマに 5mm ずつずらす
    const offsets = Array.from({ length: 41 }, (_, index) => -0.1 + index * 0.005)
    const first = stackedAt(offsets[0] ?? 0)
    let previous = relaxPoses(first, pins)
    // 体まるごと重ねた深いめり込みから始めるので、はじめの位置で押し出しきるまで落ち着かせてから、ずらしはじめる
    for (let frame = 0; frame < 30; frame += 1) previous = relaxFollowing(previous, first, pins)
    for (const offset of offsets.slice(1)) {
      const target = stackedAt(offset)
      const current = relaxFollowing(previous, target, pins)
      for (const joint of JOINTS) {
        expect(distance(current[0][joint], previous[0][joint]), `${offset}m のレイドした人の${joint}`).toBeLessThan(0.03)
        expect(distance(current[1][joint], previous[1][joint]), `${offset}m の配信者の${joint}`).toBeLessThan(0.03)
      }
      previous = current
    }
  })
})

describe('recordedPosesAt', () => {
  it('記録の間隔を渡すと、その間隔で記録を引き、あいだは前後を混ぜる', () => {
    const later: PosePair = [shifted(startPoses[0], vec(0, 0, 0.1)), startPoses[1]]
    const frames = [startPoses, later]
    expect(recordedPosesAt(frames, 20, 0)).toEqual(startPoses)
    expect(distance(recordedPosesAt(frames, 20, 10)[0].neck, add(startPoses[0].neck, vec(0, 0, 0.05)))).toBeLessThan(1e-9)
    expect(recordedPosesAt(frames, 20, 100)).toEqual(later)
  })
})

describe('bakeCollapse', () => {
  /** レイドした人が、マットの外（x の負の側）へ倒れ込む */
  const input: CollapseInput = {
    poses: startPoses,
    previous: startPoses,
    pins: startPins,
    faller: 0,
    push: vec(-1, 0, 0),
  }

  it('同じ入力からは、同じ倒れ方と同じ勝敗になる', () => {
    expect(bakeCollapse(input)).toEqual(bakeCollapse(input))
  })

  it('倒れた人の、手足の先のほかの部位がマットに着いた時刻と部位を返す', () => {
    const collapse = bakeCollapse(input)
    expect(collapse.touchdown.player).toBe(0)
    expect(LOSING_JOINTS).toContain(collapse.touchdown.joint)
    expect(collapse.touchdown.atMs).toBeGreaterThan(0)
  })

  it('マットに着いてからも少しのあいだ記録を続ける（倒れきるまで映すため）', () => {
    const collapse = bakeCollapse(input)
    expect(collapse.frames.length * COLLAPSE_FRAME_MS).toBeGreaterThanOrEqual(collapse.touchdown.atMs + COLLAPSE_AFTER_TOUCHDOWN_MS)
  })

  it('どの記録でも、関節はマットより下に沈まない', () => {
    const collapse = bakeCollapse(input)
    for (const frame of collapse.frames) {
      for (const pose of frame) {
        for (const joint of JOINTS) expect(pose[joint].y).toBeGreaterThan(JOINT_RADII[joint] - 1e-3)
      }
    }
  })

  it('記録の先頭は倒れはじめの姿勢で、骨の長さはほぼ保たれる', () => {
    const collapse = bakeCollapse(input)
    expect(collapse.frames[0]).toEqual(startPoses)
    const last = collapse.frames.at(-1)?.[0]
    if (last === undefined) throw new Error('記録がありません')
    expect(distance(last.shoulderL, last.elbowL)).toBeCloseTo(distance(startPoses[0].shoulderL, startPoses[0].elbowL), 1)
    expect(distance(last.neck, last.pelvis)).toBeCloseTo(distance(startPoses[0].neck, startPoses[0].pelvis), 1)
  })
})

describe('collapsePosesAt', () => {
  const collapse = bakeCollapse({ poses: startPoses, previous: startPoses, pins: startPins, faller: 1, push: vec(1, 0, 0) })

  it('0ミリ秒では倒れはじめの姿勢を返す', () => {
    expect(collapsePosesAt(collapse, 0)).toEqual(startPoses)
  })

  it('記録と記録のあいだは、前後の記録を混ぜた位置にする', () => {
    const [before, after] = [collapse.frames[3], collapse.frames[4]]
    if (before === undefined || after === undefined) throw new Error('記録が足りません')
    const halfway = collapsePosesAt(collapse, COLLAPSE_FRAME_MS * 3.5)
    expect(halfway[1].head.y).toBeCloseTo((before[1].head.y + after[1].head.y) / 2, 9)
  })

  it('記録の終わりより後は、最後の記録のまま止める', () => {
    expect(collapsePosesAt(collapse, 60_000)).toEqual(collapse.frames.at(-1))
  })
})
