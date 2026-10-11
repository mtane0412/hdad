/**
 * ペロペロの舐め方（種と経過時間から場面を決める）
 *
 * 1回のペロペロは「アイコンが出てくる → 舌が下から上へ何度も舐め上げる → アイコンが消える」の順に流れる。
 * 舐める回数・横の位置・傾きは種だけから決め（createLickPlan）、その時刻の場面は流しはじめてからの経過時間だけから求める
 * （lickSceneAt。フレーム間の状態を持たない）。回を重ねるごとに1回の長さを縮め、だんだん速く、しつこくする。
 *
 * 1回の舐め上げは「舌を出しながら下からねっとり舐め上げる（アイコンに当たっているあいだ舌先が押しつぶれる）→ 上で舌を離す」の順で、
 * 最後の1回だけは離す前に舌先を丸めてアイコンをすくう（issue #339）。
 * 舐めた跡（trailsAt。濡れた筋・乾き具合・下へ伸びる垂れ）と、舌を離すときの唾液の糸（salivaStringAt）も、
 * 種から決めた舐め方と経過時間だけから求める（フレーム間の状態を持たない）。
 *
 * 注意: 乱数は src/core/background.ts の createRandom だけを使い、Math.random を使わない（同じ種から同じ舐め方を再現するため）。
 * 注意: DOM も three.js も読み込まない（描画は view.ts が受け持つ）。
 */
import { createRandom } from '../core/background'

/** アイコンが出てくるまでの長さ（ミリ秒） */
export const LICK_ENTER_MS = 700
/** 舐め終えてからアイコンが消えはじめるまでの長さ（ミリ秒）。最後の跡が垂れていくのを見せる */
const LINGER_MS = 1500
/** アイコンが消えるまでの長さ（ミリ秒） */
export const LICK_EXIT_MS = 900
/** 舐める回数の下限と上限 */
export const MIN_LICK_STROKES = 5
export const MAX_LICK_STROKES = 7
/** 舐める横の位置の振れ幅（アイコンの幅を1としたときの、中心からのずれ） */
export const MAX_STROKE_OFFSET = 0.25
/** 1回目に舐め上げる長さ（ミリ秒）。はじめはゆっくり、ねっとり舐める */
const FIRST_STROKE_MS = 2000
/** 1回ごとに長さを縮める割合（回を重ねるごとに速く、しつこくする） */
const STROKE_SPEEDUP = 0.8
/** 舌を離してから次を舐めはじめるまでの間（ミリ秒） */
const STROKE_GAP_MS = 450
/** 舌の傾きの振れ幅（ラジアン） */
const MAX_TILT = 0.35
/** 1回のうち、舐め上げ終えて舌を離しはじめる進み具合 */
const PULL_START = 0.82
/** 1回のうち、舌を出しきるまでの進み具合 */
const EXTEND_SHARE = 0.12
/** 舌先がアイコンに当たっている進み具合（reach）の範囲。端はなだらかに当て・離す */
const CONTACT_FROM = 0.12
const CONTACT_FULL_FROM = 0.22
const CONTACT_FULL_TO = 0.86
const CONTACT_TO = 0.97
/** すくう回で、舌先を丸めはじめる・丸めきる進み具合 */
const CURL_FROM = 0.6
const CURL_SPAN = 0.3
/** 舌を離しはじめてから、糸が切れるまでに足す長さ（ミリ秒） */
const STRING_AFTER_MS = 350
/** 跡が乾いていく速さ（ミリ秒。この長さで濡れ具合が 1/e に近づく）と、乾ききっても残る濡れ具合 */
const DRY_MS = 4000
const MIN_WETNESS = 0.35
/** 1回の跡から垂れる数の下限と上限 */
const MIN_DRIPS = 1
const MAX_DRIPS = 3

/** 跡から垂れる唾液1本（舐め方を決めるときに種から決める） */
export interface DripPlan {
  /** 跡のどの高さから垂れるか（reach と同じ単位） */
  readonly at: number
  /** 跡の幅のどこから垂れるか（-1: 左端、1: 右端） */
  readonly side: number
  /** 舐め終えてから垂れはじめるまで（ミリ秒） */
  readonly delayMs: number
  /** 1秒に伸びる長さ（reach と同じ単位） */
  readonly speed: number
  /** 伸びきる長さ（reach と同じ単位） */
  readonly maxLength: number
}

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
  /** 舌先を丸めてアイコンをすくう回か（最後の1回だけ） */
  readonly scoop: boolean
  /** この回の跡から垂れる唾液 */
  readonly drips: readonly DripPlan[]
}

/** 1回のペロペロの舐め方 */
export interface LickPlan {
  readonly strokes: readonly LickStroke[]
  /** 流しはじめてから終わるまで（ミリ秒） */
  readonly totalMs: number
}

/** その時刻の舌 */
export interface TongueState {
  /** 舐め上げた進み具合（0: アイコンの下端より下、1: アイコンの上端を越えたところ） */
  readonly reach: number
  /** 舌を出している度合い（0: 引っ込めている、1: 出しきっている） */
  readonly extension: number
  /** 舌先がアイコンに押しつけられて平たく広がる度合い（0〜1） */
  readonly squash: number
  /** 舌先を丸めている度合い（0〜1。すくう回だけ） */
  readonly curl: number
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

/** 舐めた跡1本の、その時刻の様子 */
export interface SalivaTrail {
  readonly offset: number
  readonly tilt: number
  /** 跡が届いている高さ（reach と同じ単位。下端の 0 から伸びる） */
  readonly toReach: number
  /** 濡れ具合（1: 舐めたて、時間がたつほど下がる） */
  readonly wetness: number
  /** 垂れ（at・side は DripPlan と同じ。length は伸びた長さ） */
  readonly drips: readonly { readonly at: number; readonly side: number; readonly length: number }[]
}

/** 舌を離すときに引く唾液の糸 */
export interface SalivaString {
  readonly offset: number
  readonly tilt: number
  /** 糸がアイコンに付いている高さ（reach と同じ単位） */
  readonly anchorReach: number
  /** 伸び具合（0: 離しはじめ、1 に近いほど細く伸びきり、1 で切れる） */
  readonly stretch: number
}

/** 下限と上限のあいだの値を、0〜1 の乱数から決める */
const between = (random: () => number, min: number, max: number): number => min + (max - min) * random()

/** 下限と上限のあいだの整数を、0〜1 の乱数から決める（どちらも含む） */
const integerBetween = (random: () => number, min: number, max: number): number => min + Math.floor(random() * (max - min + 1))

/** 始まりと終わりをなめらかにする（0〜1 → 0〜1） */
const smooth = (t: number): number => t * t * (3 - 2 * t)

/** 0〜1 に収める */
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/** 舐め上げた進み具合のうち、舌先がアイコンに当たっている度合い（0〜1） */
const contactAt = (reach: number): number =>
  Math.min(smooth(clamp01((reach - CONTACT_FROM) / (CONTACT_FULL_FROM - CONTACT_FROM))), smooth(clamp01((CONTACT_TO - reach) / (CONTACT_TO - CONTACT_FULL_TO))))

/** 1回のうちの進み具合（0〜1）から、舐め上げた高さを求める。舌を離しはじめたら上で止まる */
const reachAt = (progress: number): number => smooth(clamp01(progress / PULL_START))

const endOf = (stroke: LickStroke): number => stroke.startMs + stroke.durationMs

/** 種から舐め方を決める */
export const createLickPlan = (seed: number): LickPlan => {
  const random = createRandom(seed)
  const count = integerBetween(random, MIN_LICK_STROKES, MAX_LICK_STROKES)
  const strokes: LickStroke[] = []
  let cursor = LICK_ENTER_MS
  for (let index = 0; index < count; index += 1) {
    const durationMs = Math.round(FIRST_STROKE_MS * STROKE_SPEEDUP ** index)
    const offset = between(random, -MAX_STROKE_OFFSET, MAX_STROKE_OFFSET)
    const tilt = between(random, -MAX_TILT, MAX_TILT)
    const drips = Array.from({ length: integerBetween(random, MIN_DRIPS, MAX_DRIPS) }, () => ({
      at: between(random, 0.3, 0.9),
      side: between(random, -0.8, 0.8),
      delayMs: between(random, 300, 1200),
      speed: between(random, 0.05, 0.15),
      maxLength: between(random, 0.15, 0.45),
    }))
    strokes.push({ startMs: cursor, durationMs, offset, tilt, scoop: index === count - 1, drips })
    cursor += durationMs + STROKE_GAP_MS
  }
  return { strokes, totalMs: cursor - STROKE_GAP_MS + LINGER_MS + LICK_EXIT_MS }
}

/** 流しはじめてからの経過時間の場面を求める */
export const lickSceneAt = (plan: LickPlan, elapsedMs: number): LickScene => {
  const finished = plan.strokes.filter((stroke) => elapsedMs >= endOf(stroke)).length
  if (elapsedMs >= plan.totalMs) return { phase: 'done', iconOpacity: 0, tongue: null, stroke: finished }
  if (elapsedMs < LICK_ENTER_MS) return { phase: 'enter', iconOpacity: smooth(elapsedMs / LICK_ENTER_MS), tongue: null, stroke: 0 }
  const exitStartMs = plan.totalMs - LICK_EXIT_MS
  if (elapsedMs >= exitStartMs) {
    return { phase: 'exit', iconOpacity: 1 - smooth((elapsedMs - exitStartMs) / LICK_EXIT_MS), tongue: null, stroke: finished }
  }
  const current = plan.strokes.find((stroke) => elapsedMs >= stroke.startMs && elapsedMs < endOf(stroke))
  if (current === undefined) return { phase: 'lick', iconOpacity: 1, tongue: null, stroke: finished }
  const progress = (elapsedMs - current.startMs) / current.durationMs
  const reach = reachAt(progress)
  // 出すときは根元から押し出し、離すときは引っ込める
  const extension = Math.min(clamp01(progress / EXTEND_SHARE), 1 - smooth(clamp01((progress - PULL_START) / (1 - PULL_START))))
  return {
    phase: 'lick',
    iconOpacity: 1,
    tongue: {
      reach,
      extension,
      squash: contactAt(reach) * extension,
      curl: current.scoop ? smooth(clamp01((progress - CURL_FROM) / CURL_SPAN)) : 0,
      offset: current.offset,
      tilt: current.tilt,
    },
    stroke: finished,
  }
}

/** 流しはじめてからの経過時間の、舐めた跡（舐めはじめた回ごとに1本）を求める */
export const trailsAt = (plan: LickPlan, elapsedMs: number): readonly SalivaTrail[] =>
  plan.strokes
    .filter((stroke) => elapsedMs >= stroke.startMs)
    .map((stroke) => {
      const done = elapsedMs >= endOf(stroke)
      const ageMs = done ? elapsedMs - endOf(stroke) : 0
      return {
        offset: stroke.offset,
        tilt: stroke.tilt,
        toReach: done ? 1 : reachAt((elapsedMs - stroke.startMs) / stroke.durationMs),
        wetness: MIN_WETNESS + (1 - MIN_WETNESS) * Math.exp(-ageMs / DRY_MS),
        drips: stroke.drips.map((drip) => ({
          at: drip.at,
          side: drip.side,
          length: done ? Math.min(drip.maxLength, Math.max(0, (drip.speed * (ageMs - drip.delayMs)) / 1000)) : 0,
        })),
      }
    })

/** 流しはじめてからの経過時間の、舌を離すときに引く唾液の糸を求める。引いていなければ null */
export const salivaStringAt = (plan: LickPlan, elapsedMs: number): SalivaString | null => {
  for (const stroke of plan.strokes) {
    const pullStartMs = stroke.startMs + stroke.durationMs * PULL_START
    const stretch = (elapsedMs - pullStartMs) / (endOf(stroke) - pullStartMs + STRING_AFTER_MS)
    if (stretch >= 0 && stretch < 1) return { offset: stroke.offset, tilt: stroke.tilt, anchorReach: reachAt(1), stretch }
  }
  return null
}
