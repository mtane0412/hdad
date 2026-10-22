/**
 * 漢字クイズの場面（scene.ts）のテスト
 *
 * 出題の演出は、流しはじめてからの経過時間と、Worker から届いた結果（正解者・時間切れ）が届いた時刻だけから決まる（フレーム間の状態を持たない）。
 * 「漢検○級」→ 熟語が奥から近づく → 制限時間（最後の5秒は大きなカウントダウン）→ 結果と正解の読み・解説、の順に進む。
 * 正解者が届いたら（issue #301）、届いた時刻でカウントダウンを止めて正解の読みと解説へ進む。
 * 時間切れは合成ページの時計では決めず、Worker の時間切れの知らせ（配信を止めるまでの猶予の知らせ）が届くまで残り0のまま待つ。
 * そのため、画面が「時間切れ！」から正解に切り替わることはない。
 */
import { describe, expect, it } from 'vitest'
import {
  ANSWER_LIMIT_MS,
  COUNTDOWN_SECONDS,
  GRADE_INTRO_MS,
  KANJI_QUIZ_TOTAL_MS,
  RESULT_WAIT_LIMIT_MS,
  REVEAL_MS,
  REVEAL_RESULT_MS,
  STOP_RESULT_MS,
  acceptsAnswerAt,
  kanjiQuizDismissibleAt,
  kanjiQuizEndOf,
  kanjiQuizSceneAt,
  kanjiQuizStopBannerAt,
  type KanjiQuizResult,
  type KanjiQuizStop,
} from './scene'

/** 熟語が出てからの経過時間を、流しはじめてからの経過時間にする */
const afterWord = (ms: number): number => GRADE_INTRO_MS + ms
/** 合成ページの時計での時間切れの時刻（流しはじめてから） */
const timeUpAt = afterWord(ANSWER_LIMIT_MS)
/** 正解者が届いた結果 */
const correct = (afterMs: number): KanjiQuizResult => ({ kind: 'correct', afterMs })
/** 時間切れの知らせが届いた結果 */
const timeUp = (afterMs: number): KanjiQuizResult => ({ kind: 'timeUp', afterMs })
/** 時間切れの知らせが、合成ページの時間切れちょうどに届いた結果（プレビューもこの形） */
const timeUpOnTime = timeUp(timeUpAt)

describe('kanjiQuizSceneAt', () => {
  it('はじめは級を出す', () => {
    expect(kanjiQuizSceneAt(0, null)).toMatchObject({ kind: 'grade' })
    expect(kanjiQuizSceneAt(GRADE_INTRO_MS - 1, null)).toMatchObject({ kind: 'grade' })
  })

  it('制限時間は視聴者が大喜利できるよう60秒にする', () => {
    expect(ANSWER_LIMIT_MS).toBe(60_000)
  })

  it('熟語は等倍の5分の1の大きさで出て、制限時間のあいだ止まらずに近づきつづける', () => {
    // 出たばかりの熟語が小さすぎて読めない、ということがないよう、等倍の0.2倍から近づけはじめる
    const appeared = kanjiQuizSceneAt(afterWord(0), null)
    if (appeared.kind !== 'question') throw new Error('出題の場面ではありません')
    expect(appeared.wordScale).toBeCloseTo(0.2)

    // 1秒ごとに見て、どの1秒でも前より大きくなっている（途中で止まらない）
    let previous = appeared.wordScale
    for (let ms = 1_000; ms < ANSWER_LIMIT_MS; ms += 1_000) {
      const scene = kanjiQuizSceneAt(afterWord(ms), null)
      if (scene.kind !== 'question') throw new Error('出題の場面ではありません')
      expect(scene.wordScale).toBeGreaterThan(previous)
      previous = scene.wordScale
    }

    // 時間切れの直前まで等倍に届かない
    const lastMoment = kanjiQuizSceneAt(afterWord(ANSWER_LIMIT_MS - 1), null)
    if (lastMoment.kind !== 'question') throw new Error('出題の場面ではありません')
    expect(lastMoment.wordScale).toBeLessThan(1)
    expect(lastMoment.wordScale).toBeGreaterThan(0.99)
  })

  it('残り秒数は熟語が出たときから数え、切り上げて出す', () => {
    expect(kanjiQuizSceneAt(afterWord(0), null)).toMatchObject({ kind: 'question', remainingSeconds: ANSWER_LIMIT_MS / 1000 })
    expect(kanjiQuizSceneAt(afterWord(ANSWER_LIMIT_MS - 1), null)).toMatchObject({ kind: 'question', remainingSeconds: 1 })
  })

  it('最後の5秒だけ大きなカウントダウンにする', () => {
    const countdownStartsAt = ANSWER_LIMIT_MS - COUNTDOWN_SECONDS * 1000

    expect(kanjiQuizSceneAt(afterWord(countdownStartsAt - 1), null)).toMatchObject({ kind: 'question', countdown: false, remainingSeconds: COUNTDOWN_SECONDS + 1 })
    expect(kanjiQuizSceneAt(afterWord(countdownStartsAt), null)).toMatchObject({ kind: 'question', countdown: true, remainingSeconds: COUNTDOWN_SECONDS })
  })

  it('制限時間を過ぎても、Worker の結果が届くまでは熟語を等倍で出したまま、カウントダウンを0で止めて待つ', () => {
    // 前提: 時間切れを決めるのは Worker なので、合成ページは自分の時計で「時間切れ！」を出さない
    const waiting = { kind: 'question', wordScale: 1, remainingSeconds: 0, countdown: true }
    expect(kanjiQuizSceneAt(timeUpAt, null)).toEqual(waiting)
    expect(kanjiQuizSceneAt(timeUpAt + RESULT_WAIT_LIMIT_MS - 1, null)).toEqual(waiting)
  })

  it('時間切れの知らせが届いたら、届いた時刻から時間切れの結果を見せ、REVEAL_RESULT_MS たってから解説の帯を出す', () => {
    // 前提: 時間切れの0.6秒後に、Worker から時間切れの知らせが届いた
    const notifiedAt = timeUpAt + 600
    expect(kanjiQuizSceneAt(notifiedAt - 1, timeUp(notifiedAt))).toMatchObject({ kind: 'question', remainingSeconds: 0 })
    expect(kanjiQuizSceneAt(notifiedAt, timeUp(notifiedAt))).toEqual({ kind: 'reveal', progress: 0, explanation: false })
    expect(kanjiQuizSceneAt(notifiedAt + REVEAL_RESULT_MS - 1, timeUp(notifiedAt))).toMatchObject({ kind: 'reveal', explanation: false })
    expect(kanjiQuizSceneAt(notifiedAt + REVEAL_RESULT_MS, timeUp(notifiedAt))).toMatchObject({ kind: 'reveal', explanation: true })
  })

  it('時間切れの知らせが合成ページの時間切れより先に届いても、残りの秒数は数えきってから時間切れの結果を見せる', () => {
    // 前提: 合成ページの描画が遅れていて、知らせのほうが0.3秒早く届いた
    expect(kanjiQuizSceneAt(timeUpAt - 1, timeUp(timeUpAt - 300))).toMatchObject({ kind: 'question', remainingSeconds: 1 })
    expect(kanjiQuizSceneAt(timeUpAt, timeUp(timeUpAt - 300))).toEqual({ kind: 'reveal', progress: 0, explanation: false })
  })

  it('解説を出し終えたら終わる', () => {
    expect(KANJI_QUIZ_TOTAL_MS).toBe(GRADE_INTRO_MS + ANSWER_LIMIT_MS + REVEAL_MS)
    expect(kanjiQuizEndOf(timeUpOnTime)).toBe(KANJI_QUIZ_TOTAL_MS)
    expect(kanjiQuizSceneAt(KANJI_QUIZ_TOTAL_MS, timeUpOnTime)).toEqual({ kind: 'done' })
  })

  it('各場面の進み具合は 0〜1 にする（出だしのふわっとした出し方に使う）', () => {
    expect(kanjiQuizSceneAt(GRADE_INTRO_MS / 2, null)).toEqual({ kind: 'grade', progress: 0.5 })
    expect(kanjiQuizSceneAt(timeUpAt + REVEAL_MS / 4, timeUpOnTime)).toEqual({ kind: 'reveal', progress: 0.25, explanation: true })
  })
})

describe('正解者が届いたとき（issue #301）', () => {
  /** 熟語が出てから10秒後に正解者が届いた */
  const answeredAfterMs = afterWord(10_000)

  it('届くまでは、正解者がいないときと同じく出題の場面のまま', () => {
    expect(kanjiQuizSceneAt(answeredAfterMs - 1, correct(answeredAfterMs))).toEqual(kanjiQuizSceneAt(answeredAfterMs - 1, null))
  })

  it('届いた時刻でカウントダウンを止め、正解の読みと解説を出す場面にする', () => {
    expect(kanjiQuizSceneAt(answeredAfterMs, correct(answeredAfterMs))).toEqual({ kind: 'reveal', progress: 0, explanation: false })
    expect(kanjiQuizSceneAt(answeredAfterMs + REVEAL_MS / 2, correct(answeredAfterMs))).toEqual({ kind: 'reveal', progress: 0.5, explanation: true })
  })

  it('解説の帯は、正解者が届いた時刻から REVEAL_RESULT_MS たってから出す', () => {
    expect(kanjiQuizSceneAt(answeredAfterMs + REVEAL_RESULT_MS - 1, correct(answeredAfterMs))).toMatchObject({ explanation: false })
    expect(kanjiQuizSceneAt(answeredAfterMs + REVEAL_RESULT_MS, correct(answeredAfterMs))).toMatchObject({ explanation: true })
  })

  it('解説は届いた時刻から数えて出し終え、1回の出題はそのぶん短くなる', () => {
    expect(kanjiQuizEndOf(correct(answeredAfterMs))).toBe(answeredAfterMs + REVEAL_MS)
    expect(kanjiQuizSceneAt(answeredAfterMs + REVEAL_MS, correct(answeredAfterMs))).toEqual({ kind: 'done' })
  })
})

describe('合成ページの時間切れのあとに正解者が届いたとき', () => {
  // 前提: Worker の締め切りは開く要求が届くまでの遅れのぶん合成ページの時間切れより遅いので、0で待っているあいだに正解者が届くことがある
  /** 時間切れの0.8秒後に正解者が届いた */
  const lateAnsweredAfterMs = timeUpAt + 800

  it('届くまでは0で待ち、「時間切れ！」を一度も見せない', () => {
    expect(kanjiQuizSceneAt(timeUpAt, correct(lateAnsweredAfterMs))).toMatchObject({ kind: 'question', remainingSeconds: 0 })
    expect(kanjiQuizSceneAt(lateAnsweredAfterMs - 1, correct(lateAnsweredAfterMs))).toMatchObject({ kind: 'question', remainingSeconds: 0 })
  })

  it('届いた時刻から正解者の結果を見せ、REVEAL_RESULT_MS たってから解説の帯を出し、届いた時刻から数えて出し終える', () => {
    expect(kanjiQuizSceneAt(lateAnsweredAfterMs, correct(lateAnsweredAfterMs))).toEqual({ kind: 'reveal', progress: 0, explanation: false })
    expect(kanjiQuizSceneAt(lateAnsweredAfterMs + REVEAL_RESULT_MS, correct(lateAnsweredAfterMs))).toMatchObject({ kind: 'reveal', explanation: true })
    expect(kanjiQuizEndOf(correct(lateAnsweredAfterMs))).toBe(lateAnsweredAfterMs + REVEAL_MS)
  })
})

describe('Worker の結果が届かないとき', () => {
  // 前提: 時間切れの知らせを押し出せなかった（Worker は配信を止めない）など、待っても正解者も時間切れも届かない

  it('時間切れから RESULT_WAIT_LIMIT_MS 待っても届かなければ、時間切れを出さずに出題を終える（合成ページが箱に理由を出す）', () => {
    expect(kanjiQuizEndOf(null)).toBe(timeUpAt + RESULT_WAIT_LIMIT_MS)
    expect(kanjiQuizSceneAt(timeUpAt + RESULT_WAIT_LIMIT_MS, null)).toEqual({ kind: 'done' })
  })
})

describe('acceptsAnswerAt', () => {
  it('熟語が出てから制限時間のあいだだけ、不正解の回答（直前の回答）を受け入れる', () => {
    expect(acceptsAnswerAt(GRADE_INTRO_MS - 1)).toBe(false)
    expect(acceptsAnswerAt(afterWord(0))).toBe(true)
    expect(acceptsAnswerAt(afterWord(ANSWER_LIMIT_MS - 1))).toBe(true)
    // 時間切れのあとに届いた不正解の回答は出さない
    expect(acceptsAnswerAt(afterWord(ANSWER_LIMIT_MS))).toBe(false)
  })
})

/** 時間切れの0.6秒後に、10秒の猶予（時間切れの知らせ）が届いた */
const stopAnnounced: KanjiQuizStop = { announcedAfterMs: timeUpAt + 600, graceMs: 10_000, rehearsal: false, cancelledAfterMs: null }
/** 猶予の知らせが届いたことによる、時間切れの結果 */
const stopTimeUp = timeUp(stopAnnounced.announcedAfterMs)
/** 猶予が尽きる時刻（流しはじめてから） */
const stopAt = stopAnnounced.announcedAfterMs + stopAnnounced.graceMs

describe('kanjiQuizDismissibleAt（下部バーの「演出を消す」）', () => {
  it('級と出題のあいだは消さない（消しても Worker の時間切れで配信が止まり、視聴者には何が起きたか見えないため）', () => {
    expect(kanjiQuizDismissibleAt(0, null)).toBe(false)
    expect(kanjiQuizDismissibleAt(afterWord(ANSWER_LIMIT_MS - 1), null)).toBe(false)
  })

  it('0で結果を待っているあいだも消さない', () => {
    expect(kanjiQuizDismissibleAt(timeUpAt, null)).toBe(false)
  })

  it('時間切れの知らせが届いて、正解の読みと解説を出しているあいだは消せる', () => {
    expect(kanjiQuizDismissibleAt(stopTimeUp.afterMs, stopTimeUp)).toBe(true)
  })

  it('正解者が届いたら、制限時間のうちでも消せる', () => {
    // 前提: 熟語が出て10秒で「山田太郎」さんが正解した
    const answeredAfterMs = afterWord(10_000)
    expect(kanjiQuizDismissibleAt(answeredAfterMs - 1, correct(answeredAfterMs))).toBe(false)
    expect(kanjiQuizDismissibleAt(answeredAfterMs, correct(answeredAfterMs))).toBe(true)
  })
})

describe('kanjiQuizStopBannerAt', () => {
  it('猶予が届く前と、猶予が届いていなければ何も出さない', () => {
    expect(kanjiQuizStopBannerAt(stopAnnounced.announcedAfterMs - 1, stopAnnounced)).toBeNull()
    expect(kanjiQuizStopBannerAt(40_000, null)).toBeNull()
  })

  it('本番では、猶予のあいだも猶予が尽きたあとも何も出さない（予告せずにいきなり配信を止める）', () => {
    expect(kanjiQuizStopBannerAt(stopAnnounced.announcedAfterMs, stopAnnounced)).toBeNull()
    expect(kanjiQuizStopBannerAt(stopAt - 1, stopAnnounced)).toBeNull()
    expect(kanjiQuizStopBannerAt(stopAt, stopAnnounced)).toBeNull()
  })

  it('試し再生なら、猶予が尽きたら止めないことを結果の長さだけ出し、そのあとは何も出さない', () => {
    const rehearsal = { ...stopAnnounced, rehearsal: true }

    // 猶予のあいだは本番と同じく何も出さない
    expect(kanjiQuizStopBannerAt(stopAt - 1, rehearsal)).toBeNull()
    expect(kanjiQuizStopBannerAt(stopAt, rehearsal)).toEqual({ kind: 'rehearsal' })
    expect(kanjiQuizStopBannerAt(stopAt + STOP_RESULT_MS, rehearsal)).toBeNull()
  })

  it('取り消しが届いても何も出さない（視聴者には停止の予告を見せていないため）', () => {
    const cancelled = { ...stopAnnounced, cancelledAfterMs: stopAnnounced.announcedAfterMs + 4_000 }

    expect(kanjiQuizStopBannerAt(cancelled.cancelledAfterMs, cancelled)).toBeNull()
    expect(kanjiQuizStopBannerAt(stopAt, { ...cancelled, rehearsal: true })).toBeNull()
  })

  it('試し再生で猶予が尽きたあとに取り消しが届いても、出しはじめた帯は猶予が尽きた時刻から結果の長さだけ出す', () => {
    // 試し再生は止める命令を送らないので、猶予が尽きたあとでも下部バーから取り消せる
    const cancelledAfterGrace = { ...stopAnnounced, rehearsal: true, cancelledAfterMs: stopAt + 1_000 }

    expect(kanjiQuizStopBannerAt(stopAt - 1, cancelledAfterGrace)).toBeNull()
    expect(kanjiQuizStopBannerAt(stopAt + 1_000, cancelledAfterGrace)).toEqual({ kind: 'rehearsal' })
    expect(kanjiQuizStopBannerAt(stopAt + STOP_RESULT_MS - 1, cancelledAfterGrace)).toEqual({ kind: 'rehearsal' })
    expect(kanjiQuizStopBannerAt(stopAt + STOP_RESULT_MS, cancelledAfterGrace)).toBeNull()
  })
})

describe('配信を止めるまでの猶予が届いたとき', () => {
  it('結果を出し終えるまで、1回の出題を延ばす', () => {
    // 猶予（10秒）と結果（5秒）は、解説（12秒）より長い
    expect(kanjiQuizEndOf(stopTimeUp, stopAnnounced)).toBe(stopAt + STOP_RESULT_MS)
    // 4秒で取り消されたら、取り消しの結果（4＋5秒）より解説（12秒）のほうが長いので、解説を出し終えるまで
    expect(kanjiQuizEndOf(stopTimeUp, { ...stopAnnounced, cancelledAfterMs: stopAnnounced.announcedAfterMs + 4_000 })).toBe(stopAnnounced.announcedAfterMs + REVEAL_MS)
  })

  it('解説を出し終えても、延ばしたあいだは解説を出したままにする', () => {
    expect(kanjiQuizSceneAt(stopAnnounced.announcedAfterMs + REVEAL_MS + 1000, stopTimeUp, stopAnnounced)).toEqual({ kind: 'reveal', progress: 1, explanation: true })
    expect(kanjiQuizSceneAt(stopAt + STOP_RESULT_MS, stopTimeUp, stopAnnounced)).toEqual({ kind: 'done' })
  })
})
