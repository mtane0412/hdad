/**
 * VRMの演出の動き方（motion.ts）のテスト
 *
 * 確かめること:
 * - 動き方（どちらから出てくるか・どちらへ帰るか・どちらの手で何回振るか）は種だけから決まり、同じ種なら同じになること
 * - その時刻の場面は経過時間だけから決まること（登場 → 手を振る → お辞儀 → 退場 → 終わり）
 * - 登場のはじめは画面の外、立ち止まったら正面を向き、退場の終わりは画面の外にいること
 * - 手を振るあいだは振る側の腕だけが上がり、お辞儀のあいだは背中が前へ曲がること
 * - 歩いているあいだだけ脚を振り、立っているあいだは脚をそろえること
 */
import { describe, expect, it } from 'vitest'
import { ARM_REST_Z, MAX_WAVES, MIN_WAVES, createVrmPlan, vrmSceneAt, type VrmPlan } from './motion'

/** いろいろな種で確かめるための種の一覧 */
const SEEDS = Array.from({ length: 200 }, (_, index) => index * 7919 + 358)

/** 左から出てきて、右手で3回振り、右へ帰る動き方（種に頼らずに場面を確かめるため、作った計画の向きだけを差し替える） */
const planFromLeft = (overrides: Partial<VrmPlan> = {}): VrmPlan => ({ ...createVrmPlan(358), enterFrom: 'left', exitTo: 'right', wavingHand: 'right', ...overrides })

describe('createVrmPlan', () => {
  it('同じ種からは同じ動き方を作る', () => {
    expect(createVrmPlan(20261013)).toEqual(createVrmPlan(20261013))
  })

  it('振る回数は決まった範囲に収まり、向きと手は左右どちらにもなりうる', () => {
    const plans = SEEDS.map(createVrmPlan)

    for (const plan of plans) {
      expect(plan.waveCount).toBeGreaterThanOrEqual(MIN_WAVES)
      expect(plan.waveCount).toBeLessThanOrEqual(MAX_WAVES)
      expect(plan.totalMs).toBeGreaterThan(plan.exitStartMs)
      expect(plan.exitStartMs).toBeGreaterThan(plan.bowStartMs)
      expect(plan.bowStartMs).toBeGreaterThan(plan.waveStartMs)
      expect(plan.waveStartMs).toBeGreaterThan(0)
    }
    expect(new Set(plans.map((plan) => plan.enterFrom))).toEqual(new Set(['left', 'right']))
    expect(new Set(plans.map((plan) => plan.exitTo))).toEqual(new Set(['left', 'right']))
    expect(new Set(plans.map((plan) => plan.wavingHand))).toEqual(new Set(['left', 'right']))
  })

  it('振る回数が多いほど、全体が長くなる', () => {
    const plans = SEEDS.map(createVrmPlan)
    const fewer = plans.find((plan) => plan.waveCount === MIN_WAVES)
    const more = plans.find((plan) => plan.waveCount === MAX_WAVES)

    // 種の一覧には、少ない回数と多い回数の両方が含まれている
    expect(fewer).toBeDefined()
    expect(more).toBeDefined()
    expect(more?.totalMs).toBeGreaterThan(fewer?.totalMs ?? Number.POSITIVE_INFINITY)
  })
})

describe('vrmSceneAt', () => {
  it('同じ計画と経過時間からは同じ場面を返す（フレーム間の状態を持たない）', () => {
    const plan = createVrmPlan(42)

    expect(vrmSceneAt(plan, 3210)).toEqual(vrmSceneAt(plan, 3210))
  })

  it('登場のはじめは、出てくる側の画面の外にいる', () => {
    expect(vrmSceneAt(planFromLeft(), 0)).toMatchObject({ phase: 'enter', slide: -1 })
    expect(vrmSceneAt(planFromLeft({ enterFrom: 'right' }), 0)).toMatchObject({ phase: 'enter', slide: 1 })
  })

  it('登場のあいだは進む向きを向き、立ち止まったら正面を向く', () => {
    const plan = planFromLeft()

    // 左から右へ歩くので、右（+）を向いている
    expect(vrmSceneAt(plan, plan.waveStartMs / 3).facing).toBeGreaterThan(0)
    expect(vrmSceneAt(planFromLeft({ enterFrom: 'right' }), plan.waveStartMs / 3).facing).toBeLessThan(0)
    expect(vrmSceneAt(plan, plan.waveStartMs)).toMatchObject({ phase: 'wave', slide: 0, facing: 0 })
  })

  it('手を振るあいだは、振る側の腕だけが上がり、にっこりする', () => {
    const plan = planFromLeft({ wavingHand: 'right' })
    const middle = vrmSceneAt(plan, (plan.waveStartMs + plan.bowStartMs) / 2)

    expect(middle.phase).toBe('wave')
    // 右腕は下ろしたとき +ARM_REST_Z、上げると負の向きに回る
    expect(middle.bones.rightUpperArm.z).toBeLessThan(0)
    expect(middle.bones.leftUpperArm.z).toBe(-ARM_REST_Z)
    expect(middle.happy).toBeGreaterThan(0)

    const leftHanded = vrmSceneAt(planFromLeft({ wavingHand: 'left' }), (plan.waveStartMs + plan.bowStartMs) / 2)
    expect(leftHanded.bones.leftUpperArm.z).toBeGreaterThan(0)
    expect(leftHanded.bones.rightUpperArm.z).toBe(ARM_REST_Z)
  })

  it('お辞儀のあいだは背中が前へ曲がり、腕は下ろしている', () => {
    const plan = planFromLeft()
    const middle = vrmSceneAt(plan, (plan.bowStartMs + plan.exitStartMs) / 2)

    expect(middle.phase).toBe('bow')
    expect(middle.bones.spine.x).toBeGreaterThan(0)
    expect(middle.bones.rightUpperArm.z).toBe(ARM_REST_Z)
    expect(middle.bones.leftUpperArm.z).toBe(-ARM_REST_Z)
  })

  it('退場の終わりには帰る側の画面の外にいて、全体の長さを過ぎたら終わる', () => {
    const plan = planFromLeft({ exitTo: 'right' })

    expect(vrmSceneAt(plan, plan.totalMs - 1).phase).toBe('exit')
    expect(vrmSceneAt(plan, plan.totalMs - 1).slide).toBeCloseTo(1, 2)
    expect(vrmSceneAt(planFromLeft({ exitTo: 'left' }), plan.totalMs - 1).slide).toBeCloseTo(-1, 2)
    expect(vrmSceneAt(plan, plan.totalMs).phase).toBe('done')
  })

  it('歩いているあいだは脚を振り、立っているあいだは脚をそろえる', () => {
    const plan = planFromLeft()
    const walking = Array.from({ length: 20 }, (_, index) => vrmSceneAt(plan, (plan.waveStartMs * index) / 20))
    const standing = vrmSceneAt(plan, (plan.waveStartMs + plan.bowStartMs) / 2)

    expect(walking.some((scene) => Math.abs(scene.bones.leftUpperLeg.x) > 0.1)).toBe(true)
    expect(standing.bones.leftUpperLeg.x).toBe(0)
    expect(standing.bones.rightUpperLeg.x).toBe(0)
  })
})
