/**
 * ペロペロの舐め方（motion.ts）のテスト
 *
 * 舐め方は種だけから決まり（createLickPlan）、場面は流しはじめてからの経過時間だけから決まる（lickSceneAt。フレーム間の状態を持たない）。
 * - 同じ種なら同じ舐め方、違う種なら違う舐め方になる
 * - 舐める回数は決まった範囲に収まり、1回ごとに速くなる（しつこさ）
 * - アイコンが出てから舐めはじめ、舐め終えてからアイコンが消える
 */
import { describe, expect, it } from 'vitest'
import { createLickPlan, lickSceneAt, LICK_ENTER_MS, LICK_EXIT_MS, MAX_LICK_STROKES, MAX_STROKE_OFFSET, MIN_LICK_STROKES } from './motion'

/** いろいろな種（テストで舐め方の幅を見るため） */
const SEEDS = [0, 1, 42, 338, 20261011, 4294967295]

describe('createLickPlan', () => {
  it('同じ種なら同じ舐め方になる', () => {
    expect(createLickPlan(338)).toEqual(createLickPlan(338))
  })

  it('違う種なら違う舐め方になる', () => {
    expect(createLickPlan(1)).not.toEqual(createLickPlan(2))
  })

  it.each(SEEDS)('種 %i でも、舐める回数は決まった範囲に収まる', (seed) => {
    const { strokes } = createLickPlan(seed)
    expect(strokes.length).toBeGreaterThanOrEqual(MIN_LICK_STROKES)
    expect(strokes.length).toBeLessThanOrEqual(MAX_LICK_STROKES)
  })

  it.each(SEEDS)('種 %i でも、1回ずつ順に重ならずに舐め、アイコンが出てから消えるまでに収まる', (seed) => {
    const { strokes, totalMs } = createLickPlan(seed)
    let previousEnd = LICK_ENTER_MS
    for (const stroke of strokes) {
      expect(stroke.startMs).toBeGreaterThanOrEqual(previousEnd)
      previousEnd = stroke.startMs + stroke.durationMs
    }
    expect(previousEnd).toBeLessThanOrEqual(totalMs - LICK_EXIT_MS)
  })

  it.each(SEEDS)('種 %i でも、回を重ねるごとに速く舐める（1回の長さが短くなる）', (seed) => {
    const durations = createLickPlan(seed).strokes.map((stroke) => stroke.durationMs)
    for (let index = 1; index < durations.length; index += 1) {
      expect(durations[index]).toBeLessThan(durations[index - 1] ?? Number.POSITIVE_INFINITY)
    }
  })

  it.each(SEEDS)('種 %i でも、舐める横の位置はアイコンからはみ出さない', (seed) => {
    for (const stroke of createLickPlan(seed).strokes) {
      expect(Math.abs(stroke.offset)).toBeLessThanOrEqual(MAX_STROKE_OFFSET)
    }
  })
})

describe('lickSceneAt', () => {
  const plan = createLickPlan(338)
  const first = plan.strokes[0]
  if (first === undefined) throw new Error('舐め方に1回目がありません')

  it('流しはじめはアイコンが出てくるところで、まだ舌は出ていない', () => {
    const scene = lickSceneAt(plan, 0)
    expect(scene.phase).toBe('enter')
    expect(scene.iconOpacity).toBe(0)
    expect(scene.tongue).toBeNull()
  })

  it('舐めているあいだは舌が出ていて、下から上へ進む', () => {
    const early = lickSceneAt(plan, first.startMs + first.durationMs * 0.3)
    const late = lickSceneAt(plan, first.startMs + first.durationMs * 0.7)
    expect(early.phase).toBe('lick')
    expect(early.iconOpacity).toBe(1)
    expect(early.tongue).not.toBeNull()
    expect(late.tongue?.reach ?? 0).toBeGreaterThan(early.tongue?.reach ?? 1)
    expect(early.tongue?.offset).toBe(first.offset)
  })

  it('舐めた回数は、終えた回だけ数える', () => {
    expect(lickSceneAt(plan, first.startMs + first.durationMs / 2).stroke).toBe(0)
    expect(lickSceneAt(plan, first.startMs + first.durationMs + 1).stroke).toBe(1)
  })

  it('舐め終えたらアイコンが消えていき、終わったら何も映さない', () => {
    const exiting = lickSceneAt(plan, plan.totalMs - LICK_EXIT_MS / 2)
    expect(exiting.phase).toBe('exit')
    expect(exiting.iconOpacity).toBeGreaterThan(0)
    expect(exiting.iconOpacity).toBeLessThan(1)
    expect(exiting.tongue).toBeNull()

    const done = lickSceneAt(plan, plan.totalMs)
    expect(done.phase).toBe('done')
    expect(done.iconOpacity).toBe(0)
  })
})
