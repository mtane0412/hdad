/**
 * 漢字クイズの場面（流しはじめてからの経過時間だけから決める）
 *
 * 1回の出題は次の順に進む（issue #300）。
 * 1. 級（「漢検○級」）を出す（GRADE_INTRO_MS）
 * 2. 熟語が奥から近づいてくる（ctx.scale に渡す倍率を経過時間から決める。市町村紹介のズームと同じ考え方）。
 *    制限時間（ANSWER_LIMIT_MS）は熟語が出たときから数え、熟語は制限時間のあいだ一定の速さで近づきつづけ、時間切れで等倍になる。
 *    最後の COUNTDOWN_SECONDS 秒は大きなカウントダウンにする
 * 3. 時間切れで正解の読みと解説を出す（REVEAL_MS）
 *
 * 制限時間のうちに正解者が届いたら（issue #301）、届いた時刻でカウントダウンを止めて 3. へ進み、解説はそこから REVEAL_MS 出す。
 * 正解者が届いた時刻は合成ページの時計で測った、流しはじめてからの経過時間として受け取る（フレーム間の状態ではなく、再生の入力）。
 *
 * 時間切れで配信を止めるまでの猶予（issue #302）が届いたら、解説に重ねて帯を出す（kanjiQuizStopBannerAt）。猶予のあいだは配信終了までの
 * 残り秒数、猶予が尽きたら「終了します」（試し再生なら「止めません」）、取り消しが届いたら「取り消されました」を STOP_RESULT_MS 出す。
 * 1回の出題はその結果を出し終えるまで延ばし、延ばしたあいだは解説を出したままにする。猶予と取り消しも、届いた時刻（経過時間）として受け取る。
 *
 * 注意: フレーム間の状態を持たない（.claude/CLAUDE.md の「描画とパラメータ」）。描き方は view.ts が受け持つ。
 */

/** 級を出しておく長さ（ミリ秒） */
export const GRADE_INTRO_MS = 2_000
/** 制限時間（ミリ秒）。熟語が出たときから数え、熟語はこのあいだ近づきつづける */
export const ANSWER_LIMIT_MS = 15_000
/** 大きく数える最後の秒数 */
export const COUNTDOWN_SECONDS = 5
/** 正解の読みと解説を出しておく長さ（ミリ秒） */
export const REVEAL_MS = 12_000
/** 1回の出題の長さ（ミリ秒） */
export const KANJI_QUIZ_TOTAL_MS = GRADE_INTRO_MS + ANSWER_LIMIT_MS + REVEAL_MS
/** 配信を止めるまでの猶予が尽きた・取り消されたあと、その結果を出しておく長さ（ミリ秒） */
export const STOP_RESULT_MS = 5_000

/** 熟語が出たときの倍率（奥の小さな点から近づいてくる） */
const START_SCALE = 0.05
const MS_PER_SECOND = 1_000

export type KanjiQuizScene =
  /** progress はその場面の進み具合（0〜1） */
  | { readonly kind: 'grade'; readonly progress: number }
  | {
      readonly kind: 'question'
      /** 熟語の倍率（時間切れで1） */
      readonly wordScale: number
      /** 残りの秒数（切り上げ） */
      readonly remainingSeconds: number
      /** 最後の数秒の、大きなカウントダウンを出すか */
      readonly countdown: boolean
    }
  | { readonly kind: 'reveal'; readonly progress: number }
  | { readonly kind: 'done' }

/** 時間切れで配信を止めるまでの猶予（Worker から届いた知らせ。issue #302） */
export interface KanjiQuizStop {
  /** 流しはじめてから猶予の知らせが届くまでの経過時間 */
  readonly announcedAfterMs: number
  /** 知らせが届いてから配信を止めるまでの猶予（ミリ秒） */
  readonly graceMs: number
  /** 試し再生（止めない）か */
  readonly rehearsal: boolean
  /** 流しはじめてから取り消しが届くまでの経過時間。届いていなければ null */
  readonly cancelledAfterMs: number | null
}

/** 配信を止めるまでの帯に出すもの */
export type KanjiQuizStopBanner =
  | { readonly kind: 'countdown'; readonly remainingSeconds: number }
  | { readonly kind: 'stopping' }
  | { readonly kind: 'rehearsal' }
  | { readonly kind: 'cancelled' }

/**
 * 正解者を受け入れる時間か。熟語が出てから制限時間のあいだだけ受け入れる（時間切れの後に届いた正解者は出さない）。
 *
 * @param elapsedMs 流しはじめてから、正解者が届くまでの経過時間
 */
export const acceptsAnswerAt = (elapsedMs: number): boolean => elapsedMs >= GRADE_INTRO_MS && elapsedMs < GRADE_INTRO_MS + ANSWER_LIMIT_MS

/** 配信を止める帯の結果（止める・止めない・取り消された）を出しはじめる時刻（流しはじめてからの経過時間） */
const stopResultFrom = (stop: KanjiQuizStop): number => stop.cancelledAfterMs ?? stop.announcedAfterMs + stop.graceMs

/**
 * 1回の出題の長さ（ミリ秒）。正解者が届いていれば、届いた時刻から解説を出し終えるまで。
 * 配信を止めるまでの猶予が届いていれば、その結果を出し終えるまで延ばす。
 *
 * @param answeredAfterMs 流しはじめてから正解者が届くまでの経過時間（acceptsAnswerAt が受け入れたもの）。届いていなければ null
 * @param stop 配信を止めるまでの猶予。届いていなければ null
 */
export const kanjiQuizEndOf = (answeredAfterMs: number | null, stop: KanjiQuizStop | null = null): number => {
  const base = answeredAfterMs === null ? KANJI_QUIZ_TOTAL_MS : answeredAfterMs + REVEAL_MS
  return stop === null ? base : Math.max(base, stopResultFrom(stop) + STOP_RESULT_MS)
}

/**
 * 流しはじめてから elapsedMs ミリ秒たったときの、配信を止めるまでの帯。出さないときは null。
 *
 * @param stop 配信を止めるまでの猶予。届いていなければ null
 */
export const kanjiQuizStopBannerAt = (elapsedMs: number, stop: KanjiQuizStop | null): KanjiQuizStopBanner | null => {
  if (stop === null || elapsedMs < stop.announcedAfterMs) return null
  const resultFrom = stopResultFrom(stop)
  if (elapsedMs < resultFrom) {
    return { kind: 'countdown', remainingSeconds: Math.ceil((stop.announcedAfterMs + stop.graceMs - elapsedMs) / MS_PER_SECOND) }
  }
  if (elapsedMs >= resultFrom + STOP_RESULT_MS) return null
  if (stop.cancelledAfterMs !== null) return { kind: 'cancelled' }
  return stop.rehearsal ? { kind: 'rehearsal' } : { kind: 'stopping' }
}

/**
 * 流しはじめてから elapsedMs ミリ秒たったときの場面。
 *
 * @param answeredAfterMs 流しはじめてから正解者が届くまでの経過時間（acceptsAnswerAt が受け入れたもの）。届いていなければ null
 * @param stop 配信を止めるまでの猶予。届いていなければ null（届いていれば、結果を出し終えるまで解説を出したままにする）
 */
export const kanjiQuizSceneAt = (elapsedMs: number, answeredAfterMs: number | null, stop: KanjiQuizStop | null = null): KanjiQuizScene => {
  if (elapsedMs < GRADE_INTRO_MS) return { kind: 'grade', progress: elapsedMs / GRADE_INTRO_MS }

  // 正解者が届いた時刻、届いていなければ時間切れの時刻から、正解の読みと解説を出す
  const revealAt = answeredAfterMs ?? GRADE_INTRO_MS + ANSWER_LIMIT_MS
  if (elapsedMs < revealAt) {
    const sinceWord = elapsedMs - GRADE_INTRO_MS
    // 制限時間のあいだ止まらずに近づきつづけるよう、一定の速さで大きくする
    const approach = sinceWord / ANSWER_LIMIT_MS
    const remainingSeconds = Math.ceil((ANSWER_LIMIT_MS - sinceWord) / MS_PER_SECOND)
    return {
      kind: 'question',
      wordScale: START_SCALE + (1 - START_SCALE) * approach,
      remainingSeconds,
      countdown: remainingSeconds <= COUNTDOWN_SECONDS,
    }
  }

  if (elapsedMs >= kanjiQuizEndOf(answeredAfterMs, stop)) return { kind: 'done' }
  return { kind: 'reveal', progress: Math.min(1, (elapsedMs - revealAt) / REVEAL_MS) }
}
