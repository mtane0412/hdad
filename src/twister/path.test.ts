/**
 * 手足を運ぶ経路の形と、経路の良し悪しの測り方（path.ts）のテスト
 *
 * 手足は、もとの円から指された円へ弧を描いて運ぶ。いまの弧のほかに「少し高く・低く運ぶ」「左右へ少し回る」形の候補があり、
 * 対戦を作るときに候補ごとに運んだ記録の悪さ（windowScore）を比べて選ぶ（game.ts）。
 * 悪さは、速く動いた関節の数・運び終えるのが遅れたずれ・骨どうしの突き抜けの深さから決まる。
 */
import { describe, expect, it } from 'vitest'
import { JOINTS, poseFrom, type Pose } from './body'
import { FAST_FRAME_STEP, LANDED_TOLERANCE, PATH_SHAPES, bonePenetration, fastStepsBetween, pointOnPath, shapedPath, windowScore, type Landing } from './path'
import type { PosePair } from './physics'
import { INITIAL_SPOTS, PLAYER_FACINGS } from './players'
import { contactsOf, restingOn, solvePose } from './pose'
import { add, distance, vec } from './vec'

/** 始めの置き場所の2人の姿勢 */
const initialPoses: PosePair = [solvePose(contactsOf(INITIAL_SPOTS[0]), PLAYER_FACINGS[0]), solvePose(contactsOf(INITIAL_SPOTS[1]), PLAYER_FACINGS[1])]

/** 姿勢の関節をすべて同じだけずらす */
const shifted = (pose: Pose, offset: { x: number; y: number; z: number }): Pose => poseFrom((joint) => add(pose[joint], offset))

describe('pointOnPath', () => {
  const from = restingOn(INITIAL_SPOTS[0].handR, 'handR')
  const to = restingOn({ color: 'yellow', row: 1 }, 'handR')

  it('どの候補の形でも、運びはじめはもとの円、運び終えは指された円にある', () => {
    for (const shape of PATH_SHAPES) {
      const path = shapedPath({ from, to, height: 0.25, swing: 0 }, shape)
      expect(distance(pointOnPath(path, 0), from)).toBeLessThan(1e-9)
      expect(distance(pointOnPath(path, 1), to)).toBeLessThan(1e-9)
    }
  })

  it('半分運んだところで、指定した高さだけ持ち上がり、指定した幅だけ運ぶ向きの右へ回る', () => {
    const middle = pointOnPath({ from, to, height: 0.3, swing: 0.2 }, 0.5)
    // もとの円と指された円は同じ高さなので、中ほどの高さは持ち上げた高さだけ上
    expect(middle.y - from.y).toBeCloseTo(0.3, 6)
    // 運ぶ向き（-z）の右（運ぶ向きと上向きの外積の側）は +x
    expect(middle.x - from.x).toBeCloseTo(0.2, 6)
  })

  it('もとの円と指された円が同じ位置でも、数が壊れない', () => {
    const middle = pointOnPath({ from, to: from, height: 0.25, swing: 0.15 }, 0.5)
    expect(Number.isFinite(middle.x) && Number.isFinite(middle.z)).toBe(true)
  })
})

describe('PATH_SHAPES', () => {
  it('候補の先頭は、いまの弧（高さを足さず、横へ回らない）で、同じ形は2つない', () => {
    expect(PATH_SHAPES[0]).toEqual({ height: 0, swing: 0 })
    const keys = PATH_SHAPES.map((shape) => `${shape.height}/${shape.swing}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('高く・低く運ぶ形と、左右へ回る形をどちらも含む', () => {
    expect(PATH_SHAPES.some((shape) => shape.height > 0)).toBe(true)
    expect(PATH_SHAPES.some((shape) => shape.height < 0)).toBe(true)
    expect(PATH_SHAPES.some((shape) => shape.swing > 0)).toBe(true)
    expect(PATH_SHAPES.some((shape) => shape.swing < 0)).toBe(true)
  })
})

describe('bonePenetration', () => {
  it('始めの置き場所のように2人が離れていれば 0', () => {
    expect(bonePenetration(initialPoses[0], initialPoses[1])).toBe(0)
  })

  it('骨の途中どうしが交差していれば、関節が相手から離れていても突き抜けとして数える', () => {
    // 1人目の左の前腕の中ほどを、2人目の右の前腕の中ほどが直角に横切る（肘・手の粒どうしは前腕の長さの半分ほど離れている）
    const crossingPose = (along: 'x' | 'z'): Pose =>
      poseFrom((joint) => {
        if (joint === 'elbowL') return along === 'x' ? vec(-0.15, 1, 0) : vec(0, 1, -0.15)
        if (joint === 'handL') return along === 'x' ? vec(0.15, 1, 0) : vec(0, 1, 0.15)
        // ほかの関節は遠く離しておく
        return along === 'x' ? vec(-5, 5, -5) : vec(5, 5, 5)
      })
    const a = crossingPose('x')
    const b = crossingPose('z')
    for (const joint of ['elbowL', 'handL'] as const) {
      for (const other of ['elbowL', 'handL'] as const) expect(distance(a[joint], b[other])).toBeGreaterThan(0.2)
    }
    expect(bonePenetration(a, b)).toBeGreaterThan(0)
  })
})

describe('fastStepsBetween', () => {
  it('1コマで FAST_FRAME_STEP を超えて動いた関節だけを数える', () => {
    const slow: PosePair = [shifted(initialPoses[0], vec(FAST_FRAME_STEP * 0.9, 0, 0)), initialPoses[1]]
    const fast: PosePair = [shifted(initialPoses[0], vec(FAST_FRAME_STEP * 1.1, 0, 0)), initialPoses[1]]
    expect(fastStepsBetween(initialPoses, slow)).toBe(0)
    expect(fastStepsBetween(initialPoses, fast)).toBe(JOINTS.length)
  })
})

describe('windowScore', () => {
  /** 0番の右手が、運び終えた時刻（記録の最後のコマ）に始めの円からどれだけ離れているか */
  const landing = (frame: number): Landing => ({ frame, gapOf: (poses) => distance(poses[0].handR, initialPoses[0].handR) })

  it('関節が速く動かず、運び終えた時刻に円に乗っていれば、悪さは 0 で、ほかの候補を試さなくてよい', () => {
    const score = windowScore(initialPoses, [initialPoses, initialPoses], landing(1), false)
    expect(score).toEqual({ cost: 0, clean: true })
  })

  it('関節が速く動いた記録は、悪さが増える', () => {
    const jumped: PosePair = [shifted(initialPoses[0], vec(0, 0.1, 0)), initialPoses[1]]
    // 跳ねて戻る（運び終えた時刻には円に乗っている）
    const score = windowScore(initialPoses, [jumped, initialPoses], landing(1), false)
    expect(score.clean).toBe(false)
    expect(score.cost).toBe(2 * JOINTS.length)
  })

  it('運び終えた時刻に円から離れている記録は、ずれが大きいほど悪さが増える', () => {
    const late = (gap: number): PosePair => [shifted(initialPoses[0], vec(gap, 0, 0)), initialPoses[1]]
    const near = windowScore(late(0), [late(0.03)], landing(0), false)
    const far = windowScore(late(0.1), [late(0.1)], landing(0), false)
    expect(near.clean).toBe(false)
    expect(far.cost).toBeGreaterThan(near.cost)
    // 許すずれの内なら遅れとみなさない
    expect(windowScore(late(0), [late(LANDED_TOLERANCE / 2)], landing(0), false).clean).toBe(true)
  })

  it('突き抜けも数えるときは、2人の骨が突き抜けている記録ほど悪さが増える', () => {
    // 2人目を1人目に重ねる（体ごと突き抜けている）
    const overlapped: PosePair = [initialPoses[0], initialPoses[0]]
    expect(windowScore(overlapped, [overlapped], null, false).cost).toBe(0)
    expect(windowScore(overlapped, [overlapped], null, true).cost).toBeGreaterThan(0)
  })
})
