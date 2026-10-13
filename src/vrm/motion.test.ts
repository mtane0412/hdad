/**
 * VRMのマスコットの動き方（motion.ts）のテスト
 *
 * 確かめること:
 * - 反応の動き方（どちらの手で何回振るか・お辞儀の深さ・うなずく回数）は種と反応の種類だけから決まり、同じなら同じになること
 * - 反応の種類ごとの姿（お礼は手を振ってお辞儀、手を振るはお辞儀しない、うなずくは首を縦に振る、大喜びは両手を上げる）
 * - その時刻の場面は、時刻と流している反応だけから決まること（フレーム間の状態を持たない）
 * - 反応が無いあいだは待機の姿勢で、呼吸・瞬き・視線のゆらぎが時刻とともに変わること
 * - 瞬きはときどき一瞬だけ目を閉じ、ほとんどの時間は目を開けていること
 * - 反応は手を振る → お辞儀の順に流れ、はじめと終わりは待機の姿勢とつながる（姿勢が飛ばない）こと
 * - 口の開きは、読み上げを鳴らしはじめた時刻と区切りごとの音量の列から、その時刻の音量で決まること
 */
import { describe, expect, it } from 'vitest'
import { VRM_REACTIONS } from './call'
import { ARM_REST_Z, BLINK_SLOT_MS, MAX_WAVES, MIN_WAVES, createVrmPlan, vrmSceneAt, type VrmPlan } from './motion'
import type { SpeechLevels } from '../speech/level'

/** いろいろな種で確かめるための種の一覧 */
const SEEDS = Array.from({ length: 200 }, (_, index) => index * 7919 + 358)

/** 確かめる時刻の起点（配信中のある時刻。ミリ秒） */
const BASE_TIME = Date.parse('2026-10-13T20:00:00+09:00')

/** 右手で振ってお辞儀するお礼の動き方（種に頼らずに場面を確かめるため、作った計画の手だけを差し替える） */
const rightHandedPlan = (overrides: Partial<VrmPlan> = {}): VrmPlan => ({ ...createVrmPlan(359, 'thanks'), wavingHand: 'right', ...overrides })

/** 起点から決まった間隔で時刻を並べる */
const timesFrom = (start: number, durationMs: number, stepMs: number): number[] =>
  Array.from({ length: Math.floor(durationMs / stepMs) }, (_, index) => start + index * stepMs)

describe('createVrmPlan', () => {
  it('同じ種からは同じ動き方を作る', () => {
    expect(createVrmPlan(20261013, 'thanks')).toEqual(createVrmPlan(20261013, 'thanks'))
  })

  it('振る回数は決まった範囲に収まり、振る手は左右どちらにもなりうる', () => {
    const plans = SEEDS.map((seed) => createVrmPlan(seed, 'thanks'))

    for (const plan of plans) {
      expect(plan.waveCount).toBeGreaterThanOrEqual(MIN_WAVES)
      expect(plan.waveCount).toBeLessThanOrEqual(MAX_WAVES)
      expect(plan.bowStartMs).toBeGreaterThan(0)
      expect(plan.totalMs).toBeGreaterThan(plan.bowStartMs)
    }
    expect(new Set(plans.map((plan) => plan.wavingHand))).toEqual(new Set(['left', 'right']))
  })

  it('振る回数が多いほど、全体が長くなる', () => {
    const plans = SEEDS.map((seed) => createVrmPlan(seed, 'thanks'))
    const fewer = plans.find((plan) => plan.waveCount === MIN_WAVES)
    const more = plans.find((plan) => plan.waveCount === MAX_WAVES)

    // 種の一覧には、少ない回数と多い回数の両方が含まれている
    expect(fewer).toBeDefined()
    expect(more).toBeDefined()
    expect(more?.totalMs).toBeGreaterThan(fewer?.totalMs ?? Number.POSITIVE_INFINITY)
  })
})

describe('vrmSceneAt（待機）', () => {
  it('同じ時刻からは同じ場面を返す（フレーム間の状態を持たない）', () => {
    expect(vrmSceneAt(BASE_TIME + 3210, null, null)).toEqual(vrmSceneAt(BASE_TIME + 3210, null, null))
  })

  it('反応が無いあいだは、腕を下ろして立ち、にっこりしない', () => {
    const scene = vrmSceneAt(BASE_TIME, null, null)

    expect(scene.phase).toBe('idle')
    expect(scene.bones.rightUpperArm.z).toBeCloseTo(ARM_REST_Z, 1)
    expect(scene.bones.leftUpperArm.z).toBeCloseTo(-ARM_REST_Z, 1)
    expect(scene.happy).toBe(0)
  })

  it('呼吸で胸がわずかに動き続ける', () => {
    const chests = timesFrom(BASE_TIME, 10_000, 100).map((time) => vrmSceneAt(time, null, null).bones.chest.x)

    expect(Math.max(...chests) - Math.min(...chests)).toBeGreaterThan(0.01)
    for (const chest of chests) expect(Math.abs(chest)).toBeLessThan(0.1)
  })

  it('視線がゆっくりゆらぎ、大きく横を向かない', () => {
    const yaws = timesFrom(BASE_TIME, 20_000, 100).map((time) => vrmSceneAt(time, null, null).bones.head.y)

    expect(Math.max(...yaws) - Math.min(...yaws)).toBeGreaterThan(0.03)
    for (const yaw of yaws) expect(Math.abs(yaw)).toBeLessThan(0.25)
  })

  it('瞬きは区切りごとに1回ずつ目を閉じ、ほとんどの時間は目を開けている', () => {
    const slotStart = Math.ceil(BASE_TIME / BLINK_SLOT_MS) * BLINK_SLOT_MS
    const slots = 10
    const blinks = timesFrom(slotStart, BLINK_SLOT_MS * slots, 10).map((time) => vrmSceneAt(time, null, null).blink)

    for (const blink of blinks) {
      expect(blink).toBeGreaterThanOrEqual(0)
      expect(blink).toBeLessThanOrEqual(1)
    }
    // どの区切りにも、ほとんど目を閉じた瞬間がある
    for (let slot = 0; slot < slots; slot += 1) {
      const inSlot = blinks.slice((slot * BLINK_SLOT_MS) / 10, ((slot + 1) * BLINK_SLOT_MS) / 10)
      expect(Math.max(...inSlot)).toBeGreaterThan(0.8)
    }
    expect(blinks.filter((blink) => blink > 0).length / blinks.length).toBeLessThan(0.1)
  })
})

describe('vrmSceneAt（反応）', () => {
  it('手を振るあいだは、振る側の腕だけが上がり、にっこりする', () => {
    const plan = rightHandedPlan()
    const middle = vrmSceneAt(BASE_TIME, { plan, elapsedMs: plan.bowStartMs / 2 }, null)

    expect(middle.phase).toBe('wave')
    // 右腕は下ろしたとき +ARM_REST_Z、上げると負の向きに回る
    expect(middle.bones.rightUpperArm.z).toBeLessThan(0)
    expect(middle.bones.leftUpperArm.z).toBeCloseTo(-ARM_REST_Z, 1)
    expect(middle.happy).toBeGreaterThan(0)

    const leftHanded = vrmSceneAt(BASE_TIME, { plan: rightHandedPlan({ wavingHand: 'left' }), elapsedMs: plan.bowStartMs / 2 }, null)
    expect(leftHanded.bones.leftUpperArm.z).toBeGreaterThan(0)
    expect(leftHanded.bones.rightUpperArm.z).toBeCloseTo(ARM_REST_Z, 1)
  })

  it('お辞儀のあいだは背中が前へ曲がり、腕は下ろしている', () => {
    const plan = rightHandedPlan()
    const middle = vrmSceneAt(BASE_TIME, { plan, elapsedMs: (plan.bowStartMs + plan.totalMs) / 2 }, null)

    expect(middle.phase).toBe('bow')
    expect(middle.bones.spine.x).toBeGreaterThan(0.2)
    expect(middle.bones.rightUpperArm.z).toBeCloseTo(ARM_REST_Z, 1)
    expect(middle.bones.leftUpperArm.z).toBeCloseTo(-ARM_REST_Z, 1)
  })

  it('反応のはじめと終わりは、同じ時刻の待機の姿勢とつながる', () => {
    const plan = rightHandedPlan()

    expect(vrmSceneAt(BASE_TIME, { plan, elapsedMs: 0 }, null).bones).toEqual(vrmSceneAt(BASE_TIME, null, null).bones)
    const ending = vrmSceneAt(BASE_TIME, { plan, elapsedMs: plan.totalMs - 1 }, null).bones
    const idle = vrmSceneAt(BASE_TIME, null, null).bones
    expect(ending.spine.x).toBeCloseTo(idle.spine.x, 3)
    expect(ending.rightUpperArm.z).toBeCloseTo(idle.rightUpperArm.z, 3)
  })

  it('反応の長さを過ぎたら待機に戻る', () => {
    const plan = rightHandedPlan()

    expect(vrmSceneAt(BASE_TIME, { plan, elapsedMs: plan.totalMs }, null).phase).toBe('idle')
  })

  it('反応のあいだも瞬きは続く', () => {
    const plan = rightHandedPlan()
    const slotStart = Math.ceil(BASE_TIME / BLINK_SLOT_MS) * BLINK_SLOT_MS
    const blinks = timesFrom(slotStart, BLINK_SLOT_MS, 10).map((time) => vrmSceneAt(time, { plan, elapsedMs: plan.bowStartMs / 2 }, null).blink)

    expect(Math.max(...blinks)).toBeGreaterThan(0.8)
  })
})

describe('vrmSceneAt（口パク）', () => {
  /** 起点の時刻に鳴らしはじめた、20ミリ秒ごとの音量の列 */
  const speech: SpeechLevels = { startedAt: BASE_TIME, frameMs: 20, levels: [0, 1, 0.5, 0] }

  it('読み上げが無ければ口を閉じている', () => {
    expect(vrmSceneAt(BASE_TIME, null, null).mouth).toBe(0)
  })

  it('鳴らしはじめてからの時間に当たる区切りの音量で口を開ける', () => {
    expect(vrmSceneAt(BASE_TIME + 20, null, speech).mouth).toBeCloseTo(1, 5)
    expect(vrmSceneAt(BASE_TIME + 40, null, speech).mouth).toBeCloseTo(0.5, 5)
  })

  it('区切りのあいだは、前後の音量のあいだをなめらかにつなぐ', () => {
    expect(vrmSceneAt(BASE_TIME + 30, null, speech).mouth).toBeCloseTo(0.75, 5)
  })

  it('鳴らしはじめる前と、鳴り終えたあとは口を閉じている', () => {
    expect(vrmSceneAt(BASE_TIME - 10, null, speech).mouth).toBe(0)
    expect(vrmSceneAt(BASE_TIME + 1000, null, speech).mouth).toBe(0)
  })

  it('反応のあいだも読み上げに合わせて口を動かす', () => {
    const plan = rightHandedPlan()

    expect(vrmSceneAt(BASE_TIME + 20, { plan, elapsedMs: plan.bowStartMs / 2 }, speech).mouth).toBeCloseTo(1, 5)
  })
})

describe('vrmSceneAt（反応の種類）', () => {
  /** 反応の最初から最後までを細かく区切った場面 */
  const scenesOf = (plan: VrmPlan) => timesFrom(0, plan.totalMs, 20).map((elapsedMs) => vrmSceneAt(BASE_TIME, { plan, elapsedMs }, null))

  it('どの反応も、はじめと終わりが同じ時刻の待機の姿勢とつながる', () => {
    const idle = vrmSceneAt(BASE_TIME, null, null).bones
    for (const reaction of VRM_REACTIONS) {
      const plan = createVrmPlan(359, reaction)
      expect(plan.totalMs).toBeGreaterThan(0)
      expect(vrmSceneAt(BASE_TIME, { plan, elapsedMs: 0 }, null).bones).toEqual(idle)
      const ending = vrmSceneAt(BASE_TIME, { plan, elapsedMs: plan.totalMs - 1 }, null).bones
      for (const bone of ['spine', 'neck', 'head', 'rightUpperArm', 'leftUpperArm', 'rightLowerArm', 'leftLowerArm'] as const) {
        expect(ending[bone].x).toBeCloseTo(idle[bone].x, 2)
        expect(ending[bone].z).toBeCloseTo(idle[bone].z, 2)
      }
    }
  })

  it('手を振るだけの反応は、お辞儀をしない', () => {
    const plan = { ...createVrmPlan(359, 'wave'), wavingHand: 'right' as const }
    const scenes = scenesOf(plan)

    expect(scenes.some((scene) => scene.bones.rightUpperArm.z < 0)).toBe(true)
    expect(scenes.every((scene) => scene.phase !== 'bow')).toBe(true)
    expect(Math.max(...scenes.map((scene) => scene.bones.spine.x))).toBeLessThan(0.1)
  })

  it('うなずく反応は、首を前へ倒し、腕は下ろしたまま', () => {
    const idleNeck = vrmSceneAt(BASE_TIME, null, null).bones.neck.x
    const scenes = scenesOf(createVrmPlan(359, 'nod'))

    expect(scenes.slice(1).every((scene) => scene.phase === 'nod')).toBe(true)
    expect(Math.max(...scenes.map((scene) => scene.bones.neck.x))).toBeGreaterThan(idleNeck + 0.1)
    for (const scene of scenes) {
      expect(scene.bones.rightUpperArm.z).toBeCloseTo(ARM_REST_Z, 1)
      expect(scene.bones.leftUpperArm.z).toBeCloseTo(-ARM_REST_Z, 1)
    }
  })

  it('うなずく反応は短く、お礼より早く終わる', () => {
    expect(createVrmPlan(359, 'nod').totalMs).toBeLessThan(createVrmPlan(359, 'thanks').totalMs)
    expect(createVrmPlan(359, 'nod').totalMs).toBeLessThanOrEqual(1500)
  })

  it('大喜びの反応は、両手を上げてにっこりする', () => {
    const plan = createVrmPlan(359, 'cheer')
    const middle = vrmSceneAt(BASE_TIME, { plan, elapsedMs: plan.totalMs / 2 }, null)

    expect(middle.phase).toBe('cheer')
    // 右腕は上げると負の向き、左腕は正の向きに回る
    expect(middle.bones.rightUpperArm.z).toBeLessThan(0)
    expect(middle.bones.leftUpperArm.z).toBeGreaterThan(0)
    expect(middle.happy).toBeGreaterThan(0.5)
  })
})
