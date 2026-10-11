/**
 * ペロペロの効果音を鳴らす時刻と音程（issue #340）
 *
 * 舌先がアイコンに触れはじめるたびに（1回の舐め上げにつき1回）効果音を鳴らし、音程（再生の速さ）を毎回少し変えて、
 * 同じ音の繰り返しに聞こえないようにする。時刻は舐め方（motion.ts）から、音程は種から決める（鳴らすのは sound-player.ts）。
 *
 * 注意: DOM も Audio も扱わない（いつ・どの音程で鳴らすかだけを決める）。乱数は src/core/background.ts の createRandom だけを使う。
 */
import { createRandom } from '../core/background'
import { strokeContactMs, type LickPlan } from './motion'

/** 音程（再生の速さ）の下限と上限。1 が元の音程 */
export const MIN_PITCH = 0.82
export const MAX_PITCH = 1.22

/** 効果音を1回鳴らす合図 */
export interface LickSoundCue {
  /** 流しはじめてから鳴らすまで（ミリ秒） */
  readonly atMs: number
  /** 再生の速さ（音程も一緒に変わる） */
  readonly pitch: number
}

/**
 * 舐め方から、効果音を鳴らす時刻と音程の並びを決める。
 *
 * @param seed 呼び出しの種（音程の揺らし方を決める。舐め方を決めた乱数とは別に引き直す）
 */
export const lickSoundCuesOf = (plan: LickPlan, seed: number): readonly LickSoundCue[] => {
  const random = createRandom(seed ^ 0x9e3779b9)
  return plan.strokes.map((stroke) => ({ atMs: strokeContactMs(stroke), pitch: MIN_PITCH + (MAX_PITCH - MIN_PITCH) * random() }))
}
