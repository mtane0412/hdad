/**
 * 漢字クイズの場面（流しはじめてからの経過時間だけから決める）
 *
 * 1回の出題は次の順に進む（issue #300）。
 * 1. 級（「漢検○級」）を出す（GRADE_INTRO_MS）
 * 2. 熟語が奥から近づいてくる（APPROACH_MS。ctx.scale に渡す倍率を経過時間から決める。市町村紹介のズームと同じ考え方）。
 *    制限時間（ANSWER_LIMIT_MS）は熟語が出たときから数え、最後の COUNTDOWN_SECONDS 秒は大きなカウントダウンにする
 * 3. 時間切れで正解の読みと解説を出す（REVEAL_MS）
 *
 * 注意: フレーム間の状態を持たない（.claude/CLAUDE.md の「描画とパラメータ」）。描き方は view.ts が受け持つ。
 */

/** 級を出しておく長さ（ミリ秒） */
export const GRADE_INTRO_MS = 2_000
/** 熟語が奥から近づき終えるまでの長さ（ミリ秒）。制限時間に含む */
export const APPROACH_MS = 3_000
/** 制限時間（ミリ秒）。熟語が出たときから数える */
export const ANSWER_LIMIT_MS = 30_000
/** 大きく数える最後の秒数 */
export const COUNTDOWN_SECONDS = 5
/** 正解の読みと解説を出しておく長さ（ミリ秒） */
export const REVEAL_MS = 12_000
/** 1回の出題の長さ（ミリ秒） */
export const KANJI_QUIZ_TOTAL_MS = GRADE_INTRO_MS + ANSWER_LIMIT_MS + REVEAL_MS

/** 熟語が出たときの倍率（奥の小さな点から近づいてくる） */
const START_SCALE = 0.05
const MS_PER_SECOND = 1_000

export type KanjiQuizScene =
  /** progress はその場面の進み具合（0〜1） */
  | { readonly kind: 'grade'; readonly progress: number }
  | {
      readonly kind: 'question'
      /** 熟語の倍率（近づき終えたら1） */
      readonly wordScale: number
      /** 残りの秒数（切り上げ） */
      readonly remainingSeconds: number
      /** 最後の数秒の、大きなカウントダウンを出すか */
      readonly countdown: boolean
    }
  | { readonly kind: 'reveal'; readonly progress: number }
  | { readonly kind: 'done' }

/** 出だしが速く、終わりにゆっくり止まる動き（近づいてくる熟語が手前でふわっと止まるように） */
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3

/** 流しはじめてから elapsedMs ミリ秒たったときの場面 */
export const kanjiQuizSceneAt = (elapsedMs: number): KanjiQuizScene => {
  if (elapsedMs < GRADE_INTRO_MS) return { kind: 'grade', progress: elapsedMs / GRADE_INTRO_MS }

  const sinceWord = elapsedMs - GRADE_INTRO_MS
  if (sinceWord < ANSWER_LIMIT_MS) {
    const approach = Math.min(1, sinceWord / APPROACH_MS)
    const remainingSeconds = Math.ceil((ANSWER_LIMIT_MS - sinceWord) / MS_PER_SECOND)
    return {
      kind: 'question',
      wordScale: START_SCALE + (1 - START_SCALE) * easeOutCubic(approach),
      remainingSeconds,
      countdown: remainingSeconds <= COUNTDOWN_SECONDS,
    }
  }

  const sinceTimeUp = sinceWord - ANSWER_LIMIT_MS
  if (sinceTimeUp < REVEAL_MS) return { kind: 'reveal', progress: sinceTimeUp / REVEAL_MS }
  return { kind: 'done' }
}
