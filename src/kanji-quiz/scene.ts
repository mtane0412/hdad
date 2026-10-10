/**
 * 漢字クイズの場面（流しはじめてからの経過時間だけから決める）
 *
 * 1回の出題は次の順に進む（issue #300）。
 * 1. 級（「漢検○級」）を出す（GRADE_INTRO_MS）
 * 2. 熟語が奥から近づいてくる（APPROACH_MS。ctx.scale に渡す倍率を経過時間から決める。市町村紹介のズームと同じ考え方）。
 *    制限時間（ANSWER_LIMIT_MS）は熟語が出たときから数え、最後の COUNTDOWN_SECONDS 秒は大きなカウントダウンにする
 * 3. 時間切れで正解の読みと解説を出す（REVEAL_MS）
 *
 * 制限時間のうちに正解者が届いたら（issue #301）、届いた時刻でカウントダウンを止めて 3. へ進み、解説はそこから REVEAL_MS 出す。
 * 正解者が届いた時刻は合成ページの時計で測った、流しはじめてからの経過時間として受け取る（フレーム間の状態ではなく、再生の入力）。
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

/**
 * 正解者を受け入れる時間か。熟語が出てから制限時間のあいだだけ受け入れる（時間切れの後に届いた正解者は出さない）。
 *
 * @param elapsedMs 流しはじめてから、正解者が届くまでの経過時間
 */
export const acceptsAnswerAt = (elapsedMs: number): boolean => elapsedMs >= GRADE_INTRO_MS && elapsedMs < GRADE_INTRO_MS + ANSWER_LIMIT_MS

/**
 * 1回の出題の長さ（ミリ秒）。正解者が届いていれば、届いた時刻から解説を出し終えるまで。
 *
 * @param answeredAfterMs 流しはじめてから正解者が届くまでの経過時間（acceptsAnswerAt が受け入れたもの）。届いていなければ null
 */
export const kanjiQuizEndOf = (answeredAfterMs: number | null): number => (answeredAfterMs === null ? KANJI_QUIZ_TOTAL_MS : answeredAfterMs + REVEAL_MS)

/**
 * 流しはじめてから elapsedMs ミリ秒たったときの場面。
 *
 * @param answeredAfterMs 流しはじめてから正解者が届くまでの経過時間（acceptsAnswerAt が受け入れたもの）。届いていなければ null
 */
export const kanjiQuizSceneAt = (elapsedMs: number, answeredAfterMs: number | null): KanjiQuizScene => {
  if (elapsedMs < GRADE_INTRO_MS) return { kind: 'grade', progress: elapsedMs / GRADE_INTRO_MS }

  // 正解者が届いた時刻、届いていなければ時間切れの時刻から、正解の読みと解説を出す
  const revealAt = answeredAfterMs ?? GRADE_INTRO_MS + ANSWER_LIMIT_MS
  if (elapsedMs < revealAt) {
    const sinceWord = elapsedMs - GRADE_INTRO_MS
    const approach = Math.min(1, sinceWord / APPROACH_MS)
    const remainingSeconds = Math.ceil((ANSWER_LIMIT_MS - sinceWord) / MS_PER_SECOND)
    return {
      kind: 'question',
      wordScale: START_SCALE + (1 - START_SCALE) * easeOutCubic(approach),
      remainingSeconds,
      countdown: remainingSeconds <= COUNTDOWN_SECONDS,
    }
  }

  const sinceReveal = elapsedMs - revealAt
  if (sinceReveal < REVEAL_MS) return { kind: 'reveal', progress: sinceReveal / REVEAL_MS }
  return { kind: 'done' }
}
