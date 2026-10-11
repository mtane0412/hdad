/**
 * ペロペロの舐め方（motion.ts）のテスト
 *
 * 舐め方は種だけから決まり（createLickPlan）、場面は流しはじめてからの経過時間だけから決まる（lickSceneAt。フレーム間の状態を持たない）。
 * - 同じ種なら同じ舐め方、違う種なら違う舐め方になる
 * - 舐める回数は決まった範囲に収まり、1回ごとに速くなる（しつこさ）
 * - アイコンが出てから舐めはじめ、舐め終えてからアイコンが消える
 * - 舌先はアイコンに当たると押しつぶれ、最後の1回は舌先を丸めてすくう（issue #339）
 * - 舐めた跡は濡れた筋として残って乾いていき、垂れが下へ伸び、舌が離れるときに糸を引いて切れる（issue #339）
 */
import { describe, expect, it } from 'vitest'
import {
  createLickPlan,
  lickSceneAt,
  salivaStringAt,
  trailsAt,
  LICK_ENTER_MS,
  LICK_EXIT_MS,
  MAX_LICK_STROKES,
  MAX_STROKE_OFFSET,
  MIN_LICK_STROKES,
  type LickStroke,
} from './motion'

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

describe('キモさの動き（舌先の押しつぶれ・最後のすくい上げ）', () => {
  const plan = createLickPlan(20261011)
  const [first] = plan.strokes
  const last = plan.strokes.at(-1)
  if (first === undefined || last === undefined) throw new Error('舐め方がありません')
  /** その回の進み具合（0〜1）の時刻 */
  const at = (stroke: LickStroke, progress: number): number => stroke.startMs + stroke.durationMs * progress

  it('最後の1回だけが、舌先を丸めてアイコンをすくう回になる', () => {
    expect(plan.strokes.map((stroke) => stroke.scoop)).toEqual([...plan.strokes.slice(1).map(() => false), true])
  })

  it('舌先がアイコンに当たっているあいだは押しつぶれ、アイコンの下にいるうちはつぶれない', () => {
    expect(lickSceneAt(plan, at(first, 0.02)).tongue?.squash).toBe(0)
    expect(lickSceneAt(plan, at(first, 0.45)).tongue?.squash ?? 0).toBeGreaterThan(0.5)
  })

  it('すくう回の終わりでは舌先を丸め、ほかの回では丸めない', () => {
    expect(lickSceneAt(plan, at(last, 0.9)).tongue?.curl ?? 0).toBeGreaterThan(0.5)
    expect(lickSceneAt(plan, at(first, 0.9)).tongue?.curl).toBe(0)
  })
})

describe('trailsAt（舐めた跡）', () => {
  const plan = createLickPlan(338)
  const [first, second] = plan.strokes
  if (first === undefined || second === undefined) throw new Error('舐め方が2回ありません')

  it('舐めはじめる前は跡が無い', () => {
    expect(trailsAt(plan, first.startMs - 1)).toEqual([])
  })

  it('舐めているあいだは、舌先が通ったところまで跡が伸びる', () => {
    const middle = first.startMs + first.durationMs / 2
    const trails = trailsAt(plan, middle)
    expect(trails).toHaveLength(1)
    expect(trails[0]?.toReach).toBeCloseTo(lickSceneAt(plan, middle).tongue?.reach ?? -1)
    expect(trails[0]?.offset).toBe(first.offset)
  })

  it('舐め終えた回の跡は上まで残り、回を重ねるごとに増える', () => {
    const trails = trailsAt(plan, second.startMs + 1)
    expect(trails).toHaveLength(2)
    expect(trails[0]?.toReach).toBe(1)
  })

  it('跡は時間がたつと乾いていく（濡れ具合が下がる）', () => {
    const end = first.startMs + first.durationMs
    const fresh = trailsAt(plan, end)[0]?.wetness ?? 0
    const later = trailsAt(plan, end + 3000)[0]?.wetness ?? 1
    expect(later).toBeLessThan(fresh)
    expect(later).toBeGreaterThan(0)
  })

  it('垂れは舐めた直後には無く、時間がたつほど下へ伸びる', () => {
    const end = first.startMs + first.durationMs
    const lengthsAt = (time: number): number[] => (trailsAt(plan, time)[0]?.drips ?? []).map((drip) => drip.length)
    expect(lengthsAt(end).every((length) => length === 0)).toBe(true)
    const soon = lengthsAt(end + 1500)
    const later = lengthsAt(end + 4000)
    expect(soon.length).toBeGreaterThan(0)
    later.forEach((length, index) => expect(length).toBeGreaterThanOrEqual(soon[index] ?? Number.POSITIVE_INFINITY))
    expect(later.some((length, index) => length > (soon[index] ?? 0))).toBe(true)
  })

  it('同じ時刻なら何度求めても同じ跡になる（フレーム間の状態を持たない）', () => {
    const time = second.startMs + second.durationMs / 3
    expect(trailsAt(plan, time)).toEqual(trailsAt(plan, time))
  })
})

describe('salivaStringAt（唾液の糸）', () => {
  const plan = createLickPlan(338)
  const [first] = plan.strokes
  if (first === undefined) throw new Error('舐め方がありません')
  const end = first.startMs + first.durationMs

  it('舌をアイコンに押し当てているあいだは糸が無い', () => {
    expect(salivaStringAt(plan, first.startMs + first.durationMs / 2)).toBeNull()
  })

  it('舌が離れるときに糸が伸び、細くなって切れる', () => {
    const early = salivaStringAt(plan, end - 50)
    const late = salivaStringAt(plan, end + 150)
    expect(early).not.toBeNull()
    expect(late?.stretch ?? 0).toBeGreaterThan(early?.stretch ?? 1)
    expect(salivaStringAt(plan, first.startMs + first.durationMs + 5000)).toBeNull()
  })
})
