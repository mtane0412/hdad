/**
 * ペロペロの効果音を鳴らす時刻（sound-cues.ts）のテスト
 *
 * 舌先がアイコンに触れるたびに1回鳴らし、音程（再生の速さ）を毎回少し変える。時刻と音程は舐め方（種）だけから決まる。
 * 1回の音はその回で舌を離し終えるまでで止める（長い音声でも、演出が終わったあとまで鳴り続けない）。
 */
import { describe, expect, it } from 'vitest'
import { createLickPlan, lickSceneAt } from './motion'
import { lickSoundCuesOf, MAX_PITCH, MIN_PITCH } from './sound-cues'

const plan = createLickPlan(338)

describe('lickSoundCuesOf', () => {
  const cues = lickSoundCuesOf(plan, 338)

  it('舐める回ごとに1回鳴らす', () => {
    expect(cues).toHaveLength(plan.strokes.length)
  })

  it('舌先がアイコンに触れはじめた時刻に鳴らす（直前はまだつぶれていない）', () => {
    for (const cue of cues) {
      expect(lickSceneAt(plan, cue.atMs - 30).tongue?.squash ?? 0).toBeLessThan(0.05)
      expect(lickSceneAt(plan, cue.atMs + 150).tongue?.squash ?? 0).toBeGreaterThan(0)
    }
  })

  it('1回の音は、その回で舌を離し終える時刻までで止める', () => {
    cues.forEach((cue, index) => {
      const stroke = plan.strokes[index]
      if (stroke === undefined) throw new Error('合図に対応する回がありません')
      expect(cue.durationMs).toBeGreaterThan(0)
      expect(cue.atMs + cue.durationMs).toBeCloseTo(stroke.startMs + stroke.durationMs)
    })
  })

  it('最後の音も、演出が終わるより前に止まる', () => {
    const last = cues.at(-1)
    expect((last?.atMs ?? 0) + (last?.durationMs ?? Number.POSITIVE_INFINITY)).toBeLessThan(plan.totalMs)
  })

  it('音程は決まった範囲で毎回少し変わる', () => {
    for (const cue of cues) {
      expect(cue.pitch).toBeGreaterThanOrEqual(MIN_PITCH)
      expect(cue.pitch).toBeLessThanOrEqual(MAX_PITCH)
    }
    expect(new Set(cues.map((cue) => cue.pitch)).size).toBe(cues.length)
  })

  it('同じ舐め方と種なら同じ時刻と音程になる', () => {
    expect(lickSoundCuesOf(plan, 338)).toEqual(cues)
  })
})
