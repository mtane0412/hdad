/**
 * ペロペロの舐め方（種と経過時間から場面を決める）
 *
 * 1回のペロペロは「アイコンが出てくる → 舌が下から上へ何度も舐め上げる → アイコンが消える」の順に流れる。
 * 舐める回数・横の位置・傾きは種だけから決め（createLickPlan）、その時刻の場面は流しはじめてからの経過時間だけから求める
 * （lickSceneAt。フレーム間の状態を持たない）。回を重ねるごとに1回の長さを縮め、だんだん速く、しつこくする。
 *
 * 注意: 乱数は src/core/background.ts の createRandom だけを使い、Math.random を使わない（同じ種から同じ舐め方を再現するため）。
 * 注意: DOM も three.js も読み込まない（描画は view.ts が受け持つ）。
 */
import { createRandom } from '../core/background'

/** アイコンが出てくるまでの長さ（ミリ秒） */
export const LICK_ENTER_MS = 700
/** 舐め終えてからアイコンが消えるまでの長さ（ミリ秒） */
export const LICK_EXIT_MS = 900
/** 舐める回数の下限と上限 */
export const MIN_LICK_STROKES = 4
export const MAX_LICK_STROKES = 6
/** 舐める横の位置の振れ幅（アイコンの幅を1としたときの、中心からのずれ） */
export const MAX_STROKE_OFFSET = 0.25
/** 1回目に舐め上げる長さ（ミリ秒） */
const FIRST_STROKE_MS = 1500
/** 1回ごとに長さを縮める割合（回を重ねるごとに速くする） */
const STROKE_SPEEDUP = 0.82
/** 舐め上げたあと、舌を引っ込めて次を舐めはじめるまでの間（ミリ秒） */
const STROKE_GAP_MS = 220
/** 舌の傾きの振れ幅（ラジアン） */
const MAX_TILT = 0.35
/** 舐め上げるうち、舌を出しきるまで・引っ込めはじめるまでの割合 */
const EXTEND_SHARE = 0.15

/** 1回の舐め上げ */
export interface LickStroke {
  /** 流しはじめてから舐めはじめるまで（ミリ秒） */
  readonly startMs: number
  /** 舐め上げる長さ（ミリ秒） */
  readonly durationMs: number
  /** 舐める横の位置（アイコンの幅を1としたときの、中心からのずれ。右が正） */
  readonly offset: number
  /** 舌の傾き（ラジアン。正は左回り） */
  readonly tilt: number
}

/** 1回のペロペロの舐め方 */
export interface LickPlan {
  readonly strokes: readonly LickStroke[]
  /** 流しはじめてから終わるまで（ミリ秒） */
  readonly totalMs: number
}

/** その時刻の舌 */
export interface TongueState {
  /** 舐め上げた進み具合（0: アイコンの下端、1: アイコンの上端を越えたところ） */
  readonly reach: number
  /** 舌を出している度合い（0: 引っ込めている、1: 出しきっている） */
  readonly extension: number
  readonly offset: number
  readonly tilt: number
}

/** その時刻の場面 */
export interface LickScene {
  readonly phase: 'enter' | 'lick' | 'exit' | 'done'
  /** アイコンの不透明度（0〜1） */
  readonly iconOpacity: number
  /** 舌。引っ込めているあいだは null */
  readonly tongue: TongueState | null
  /** 舐め終えた回数 */
  readonly stroke: number
}

/** 下限と上限のあいだの値を、0〜1 の乱数から決める */
const between = (random: () => number, min: number, max: number): number => min + (max - min) * random()

/** 始まりと終わりをなめらかにする（0〜1 → 0〜1） */
const smooth = (t: number): number => t * t * (3 - 2 * t)

/** 0〜1 に収める */
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/** 種から舐め方を決める */
export const createLickPlan = (seed: number): LickPlan => {
  const random = createRandom(seed)
  const count = MIN_LICK_STROKES + Math.floor(random() * (MAX_LICK_STROKES - MIN_LICK_STROKES + 1))
  const strokes: LickStroke[] = []
  let cursor = LICK_ENTER_MS
  for (let index = 0; index < count; index += 1) {
    const durationMs = Math.round(FIRST_STROKE_MS * STROKE_SPEEDUP ** index)
    strokes.push({ startMs: cursor, durationMs, offset: between(random, -MAX_STROKE_OFFSET, MAX_STROKE_OFFSET), tilt: between(random, -MAX_TILT, MAX_TILT) })
    cursor += durationMs + STROKE_GAP_MS
  }
  return { strokes, totalMs: cursor - STROKE_GAP_MS + LICK_EXIT_MS }
}

/** 流しはじめてからの経過時間の場面を求める */
export const lickSceneAt = (plan: LickPlan, elapsedMs: number): LickScene => {
  const finished = plan.strokes.filter((stroke) => elapsedMs >= stroke.startMs + stroke.durationMs).length
  if (elapsedMs >= plan.totalMs) return { phase: 'done', iconOpacity: 0, tongue: null, stroke: finished }
  if (elapsedMs < LICK_ENTER_MS) return { phase: 'enter', iconOpacity: smooth(elapsedMs / LICK_ENTER_MS), tongue: null, stroke: 0 }
  const exitStartMs = plan.totalMs - LICK_EXIT_MS
  if (elapsedMs >= exitStartMs) {
    return { phase: 'exit', iconOpacity: 1 - smooth((elapsedMs - exitStartMs) / LICK_EXIT_MS), tongue: null, stroke: finished }
  }
  const current = plan.strokes.find((stroke) => elapsedMs >= stroke.startMs && elapsedMs < stroke.startMs + stroke.durationMs)
  if (current === undefined) return { phase: 'lick', iconOpacity: 1, tongue: null, stroke: finished }
  const progress = (elapsedMs - current.startMs) / current.durationMs
  return {
    phase: 'lick',
    iconOpacity: 1,
    tongue: {
      reach: smooth(progress),
      extension: clamp01(Math.min(progress, 1 - progress) / EXTEND_SHARE),
      offset: current.offset,
      tilt: current.tilt,
    },
    stroke: finished,
  }
}
