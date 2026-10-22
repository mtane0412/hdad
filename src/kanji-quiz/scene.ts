/**
 * 漢字クイズの場面（流しはじめてからの経過時間だけから決める）
 *
 * 1回の出題は次の順に進む（issue #300）。
 * 1. 級（「漢検○級」）を出す（GRADE_INTRO_MS）
 * 2. 熟語が奥から近づいてくる（ctx.scale に渡す倍率を経過時間から決める。市町村紹介のズームと同じ考え方）。
 *    制限時間（ANSWER_LIMIT_MS）は熟語が出たときから数え、熟語は制限時間のあいだ一定の速さで近づきつづけ、時間切れで等倍になる。
 *    最後の COUNTDOWN_SECONDS 秒は大きなカウントダウンにする
 * 3. Worker の結果（正解者か時間切れ）が届いたら、正解の読みと解説を出す（REVEAL_MS）。
 *    はじめの REVEAL_RESULT_MS は結果（「○○さん 正解！」か「時間切れ！」）だけを見せ、そのあと解説の帯を出す（帯を出すときに解説の音を鳴らすため）
 *
 * 制限時間のうちに正解者が届いたら（issue #301）、届いた時刻でカウントダウンを止めて 3. へ進み、解説はそこから REVEAL_MS 出す。
 * 時間切れは合成ページの時計では決めない。制限時間を数えきったら、熟語を等倍で出したままカウントダウンを0で止め、
 * Worker から正解者か時間切れの知らせ（配信を止めるまでの猶予の知らせ）が届くのを待つ。Worker はどちらか一方しか押し出さないので、
 * 画面が「時間切れ！」から正解に切り替わることはない（Worker の締め切りは開く要求が届くまでの遅れのぶん合成ページより少し遅いので、0のあいだに正解者が届くことがある）。
 * RESULT_WAIT_LIMIT_MS 待っても届かなければ、時間切れを出さずに出題を終える（理由を箱に出すのは合成ページ）。
 * 結果が届いた時刻は合成ページの時計で測った、流しはじめてからの経過時間として受け取る（フレーム間の状態ではなく、再生の入力）。
 *
 * 時間切れで配信を止めるまでの猶予（issue #302）が届いても、本番では何も出さずにいきなり配信を止める（予告しないほうが面白いため）。
 * 試し再生だけは、猶予が尽きたら解説に重ねて「止めません」の帯を STOP_RESULT_MS 出す（kanjiQuizStopBannerAt）。取り消されたら何も出さない。
 * 1回の出題は猶予の結果を出し終えるまで延ばし、延ばしたあいだは解説を出したままにする。猶予と取り消しも、届いた時刻（経過時間）として受け取る。
 *
 * 注意: フレーム間の状態を持たない（.claude/CLAUDE.md の「描画とパラメータ」）。描き方は view.ts が受け持つ。
 */

/** 級を出しておく長さ（ミリ秒） */
export const GRADE_INTRO_MS = 2_000
/** 制限時間（ミリ秒）。熟語が出たときから数え、熟語はこのあいだ近づきつづける。視聴者が他の人の回答を見てひねった答え（大喜利）を返せるよう長めにとる */
export const ANSWER_LIMIT_MS = 60_000
/** 大きく数える最後の秒数 */
export const COUNTDOWN_SECONDS = 5
/** 正解の読みと解説を出しておく長さ（ミリ秒） */
export const REVEAL_MS = 12_000
/** 正解の読みと解説を出す場面のうち、はじめに結果（正解者・時間切れ）だけを見せる長さ（ミリ秒）。これを過ぎたら解説の帯を出す */
export const REVEAL_RESULT_MS = 1_500
/**
 * 制限時間を数えきってから、Worker の結果（正解者・時間切れ）を待つ上限（ミリ秒）。
 * 結果はふつう1秒ほどで届く。これを過ぎても届かなければ、押し出しに失敗したとみなして出題を終える
 */
export const RESULT_WAIT_LIMIT_MS = 10_000
/** 合成ページの時計での時間切れの時刻（流しはじめてから） */
const TIME_UP_AT = GRADE_INTRO_MS + ANSWER_LIMIT_MS
/** 時間切れの知らせが時間切れちょうどに届いたときの、1回の出題の長さ（ミリ秒） */
export const KANJI_QUIZ_TOTAL_MS = GRADE_INTRO_MS + ANSWER_LIMIT_MS + REVEAL_MS
/** 配信を止めるまでの猶予が尽きた・取り消されたあと、その結果を出しておく長さ（ミリ秒） */
export const STOP_RESULT_MS = 5_000

/** 熟語が出たときの倍率（奥から近づいてくる。小さすぎると出たばかりの熟語が点にしか見えないので、読める大きさから始める） */
const START_SCALE = 0.2
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
  | {
      readonly kind: 'reveal'
      readonly progress: number
      /** 解説の帯（熟語・正解の読み・解説）を出すか。はじめの REVEAL_RESULT_MS は結果だけを見せるので false */
      readonly explanation: boolean
    }
  | { readonly kind: 'done' }

/**
 * Worker から届いた出題の結果。afterMs は流しはじめてから届くまでの経過時間。
 * 時間切れは、配信を止めるまでの猶予の知らせ（Worker が締め切りに正解者がいないと判定して押し出すもの）が届いたことで決まる。
 * プレビューは Worker につながないので、時間切れちょうどに時間切れが届いたものとして扱う
 */
export type KanjiQuizResult =
  | { readonly kind: 'correct'; readonly afterMs: number }
  | { readonly kind: 'timeUp'; readonly afterMs: number }

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

/** 配信を止める時刻に出す帯。出すのは試し再生で止めないことだけ */
export type KanjiQuizStopBanner = { readonly kind: 'rehearsal' }

/**
 * 不正解の回答（直前の回答）を受け入れる時間か。熟語が出てから制限時間のあいだだけ受け入れる。
 *
 * 正解者には使わない。時間切れの判定は Worker が持ち、Worker の締め切りは開く要求が届くまでの遅れのぶんわずかに遅いので、
 * 合成ページの時間切れのあとに正解者が届くことがある（そのあいだは0で結果を待つ）。
 *
 * @param elapsedMs 流しはじめてから、回答が届くまでの経過時間
 */
export const acceptsAnswerAt = (elapsedMs: number): boolean => elapsedMs >= GRADE_INTRO_MS && elapsedMs < TIME_UP_AT

/** 配信を止める帯の結果（止める・止めない・取り消された）を出しはじめる時刻（流しはじめてからの経過時間） */
const stopResultFrom = (stop: KanjiQuizStop): number => stop.cancelledAfterMs ?? stop.announcedAfterMs + stop.graceMs

/**
 * 結果（正解者・時間切れ）を見せはじめる時刻（流しはじめてからの経過時間）。
 * 時間切れの知らせが合成ページの時間切れより先に届いても（合成ページの描画が遅れていた など）、残りの秒数を数えきってから見せる。
 */
export const kanjiQuizRevealAt = (result: KanjiQuizResult): number => (result.kind === 'correct' ? result.afterMs : Math.max(result.afterMs, TIME_UP_AT))

/**
 * 1回の出題の長さ（ミリ秒）。結果が届いていれば、届いた時刻から解説を出し終えるまで。
 * 届いていなければ、時間切れから結果を待つ上限まで。配信を止めるまでの猶予が届いていれば、その結果を出し終えるまで延ばす。
 *
 * @param result Worker から届いた結果。届いていなければ null
 * @param stop 配信を止めるまでの猶予。届いていなければ null
 */
export const kanjiQuizEndOf = (result: KanjiQuizResult | null, stop: KanjiQuizStop | null = null): number => {
  const base = result === null ? TIME_UP_AT + RESULT_WAIT_LIMIT_MS : kanjiQuizRevealAt(result) + REVEAL_MS
  return stop === null ? base : Math.max(base, stopResultFrom(stop) + STOP_RESULT_MS)
}

/**
 * 流しはじめてから elapsedMs ミリ秒たったときの、配信を止める時刻の帯。出さないときは null。
 * 本番は予告せずにいきなり止めるので何も出さず、試し再生で猶予が尽きたときだけ止めないことを出す。
 *
 * @param stop 配信を止めるまでの猶予。届いていなければ null
 */
export const kanjiQuizStopBannerAt = (elapsedMs: number, stop: KanjiQuizStop | null): KanjiQuizStopBanner | null => {
  if (stop === null || !stop.rehearsal) return null
  const graceEndsAt = stop.announcedAfterMs + stop.graceMs
  // 猶予のうちに取り消されたら出さない。猶予が尽きたあとの取り消し（試し再生は止める命令を送らないので届きうる）では、出しはじめた帯を消さない
  if (stop.cancelledAfterMs !== null && stop.cancelledAfterMs < graceEndsAt) return null
  return elapsedMs >= graceEndsAt && elapsedMs < graceEndsAt + STOP_RESULT_MS ? { kind: 'rehearsal' } : null
}

/**
 * 流しはじめてから elapsedMs ミリ秒たったときの場面。
 *
 * @param result Worker から届いた結果。届いていなければ null（制限時間を数えきったら0で待つ）
 * @param stop 配信を止めるまでの猶予。届いていなければ null（届いていれば、結果を出し終えるまで解説を出したままにする）
 */
export const kanjiQuizSceneAt = (elapsedMs: number, result: KanjiQuizResult | null, stop: KanjiQuizStop | null = null): KanjiQuizScene => {
  if (elapsedMs < GRADE_INTRO_MS) return { kind: 'grade', progress: elapsedMs / GRADE_INTRO_MS }
  if (elapsedMs >= kanjiQuizEndOf(result, stop)) return { kind: 'done' }

  const revealAt = result === null ? null : kanjiQuizRevealAt(result)
  if (revealAt === null || elapsedMs < revealAt) {
    // 制限時間を数えきったら、熟語を等倍で出したままカウントダウンを0で止めて結果を待つ
    const sinceWord = Math.min(elapsedMs - GRADE_INTRO_MS, ANSWER_LIMIT_MS)
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

  const sinceReveal = elapsedMs - revealAt
  return { kind: 'reveal', progress: Math.min(1, sinceReveal / REVEAL_MS), explanation: sinceReveal >= REVEAL_RESULT_MS }
}

/**
 * 下部バーの「演出を消す」で、流している出題を消してよいか。正解の読みと解説に入ってからだけ消せる。
 *
 * 級と出題のあいだは消さない。時間切れの判定と配信の停止は Worker が持つので、消しても出題は続き、
 * 誰も正解しなければ視聴者には問題が見えないまま配信が止まってしまうため。
 *
 * @param elapsedMs 流しはじめてからの経過時間
 * @param result Worker から届いた結果。届いていなければ null
 */
export const kanjiQuizDismissibleAt = (elapsedMs: number, result: KanjiQuizResult | null): boolean => {
  const { kind } = kanjiQuizSceneAt(elapsedMs, result)
  return kind === 'reveal' || kind === 'done'
}
