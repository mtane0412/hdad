/**
 * 漢字クイズの場面（scene.ts）のテスト
 *
 * 出題の演出は、流しはじめてからの経過時間だけから決まる（フレーム間の状態を持たない）。
 * 「漢検○級」→ 熟語が奥から近づく → 制限時間（最後の5秒は大きなカウントダウン）→ 時間切れで正解の読みと解説、の順に進む。
 * 正解者が届いたら（issue #301）、届いた時刻でカウントダウンを止めて正解の読みと解説へ進む。
 */
import { describe, expect, it } from 'vitest'
import { ANSWER_LIMIT_MS, APPROACH_MS, COUNTDOWN_SECONDS, GRADE_INTRO_MS, KANJI_QUIZ_TOTAL_MS, REVEAL_MS, acceptsAnswerAt, kanjiQuizEndOf, kanjiQuizSceneAt } from './scene'

/** 熟語が出てからの経過時間を、流しはじめてからの経過時間にする */
const afterWord = (ms: number): number => GRADE_INTRO_MS + ms

describe('kanjiQuizSceneAt', () => {
  it('はじめは級を出す', () => {
    expect(kanjiQuizSceneAt(0, null)).toMatchObject({ kind: 'grade' })
    expect(kanjiQuizSceneAt(GRADE_INTRO_MS - 1, null)).toMatchObject({ kind: 'grade' })
  })

  it('級のあとは熟語を小さく出し、近づき終えたら等倍にする', () => {
    const appeared = kanjiQuizSceneAt(afterWord(0), null)
    const halfway = kanjiQuizSceneAt(afterWord(APPROACH_MS / 2), null)
    const arrived = kanjiQuizSceneAt(afterWord(APPROACH_MS), null)

    if (appeared.kind !== 'question' || halfway.kind !== 'question' || arrived.kind !== 'question') throw new Error('出題の場面ではありません')
    expect(appeared.wordScale).toBeLessThan(0.1)
    expect(halfway.wordScale).toBeGreaterThan(appeared.wordScale)
    expect(halfway.wordScale).toBeLessThan(1)
    expect(arrived.wordScale).toBe(1)
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

  it('制限時間を過ぎたら、正解の読みと解説を出す場面にする', () => {
    expect(kanjiQuizSceneAt(afterWord(ANSWER_LIMIT_MS), null)).toMatchObject({ kind: 'reveal' })
    expect(kanjiQuizSceneAt(afterWord(ANSWER_LIMIT_MS + REVEAL_MS - 1), null)).toMatchObject({ kind: 'reveal' })
  })

  it('解説を出し終えたら終わる', () => {
    expect(KANJI_QUIZ_TOTAL_MS).toBe(GRADE_INTRO_MS + ANSWER_LIMIT_MS + REVEAL_MS)
    expect(kanjiQuizSceneAt(KANJI_QUIZ_TOTAL_MS, null)).toEqual({ kind: 'done' })
  })

  it('各場面の進み具合は 0〜1 にする（出だしのふわっとした出し方に使う）', () => {
    expect(kanjiQuizSceneAt(GRADE_INTRO_MS / 2, null)).toEqual({ kind: 'grade', progress: 0.5 })
    expect(kanjiQuizSceneAt(afterWord(ANSWER_LIMIT_MS + REVEAL_MS / 4), null)).toEqual({ kind: 'reveal', progress: 0.25 })
  })
})

describe('正解者が届いたとき（issue #301）', () => {
  /** 熟語が出てから10秒後に正解者が届いた */
  const answeredAfterMs = afterWord(10_000)

  it('届くまでは、正解者がいないときと同じく出題の場面のまま', () => {
    expect(kanjiQuizSceneAt(answeredAfterMs - 1, answeredAfterMs)).toEqual(kanjiQuizSceneAt(answeredAfterMs - 1, null))
  })

  it('届いた時刻でカウントダウンを止め、正解の読みと解説を出す場面にする', () => {
    expect(kanjiQuizSceneAt(answeredAfterMs, answeredAfterMs)).toEqual({ kind: 'reveal', progress: 0 })
    expect(kanjiQuizSceneAt(answeredAfterMs + REVEAL_MS / 2, answeredAfterMs)).toEqual({ kind: 'reveal', progress: 0.5 })
  })

  it('解説は届いた時刻から数えて出し終え、1回の出題はそのぶん短くなる', () => {
    expect(kanjiQuizEndOf(answeredAfterMs)).toBe(answeredAfterMs + REVEAL_MS)
    expect(kanjiQuizSceneAt(answeredAfterMs + REVEAL_MS, answeredAfterMs)).toEqual({ kind: 'done' })
  })

  it('正解者がいなければ、1回の出題の長さは時間切れまで流したときの長さ', () => {
    expect(kanjiQuizEndOf(null)).toBe(KANJI_QUIZ_TOTAL_MS)
  })
})

describe('acceptsAnswerAt', () => {
  it('熟語が出てから制限時間のあいだだけ、正解者を受け入れる', () => {
    expect(acceptsAnswerAt(GRADE_INTRO_MS - 1)).toBe(false)
    expect(acceptsAnswerAt(afterWord(0))).toBe(true)
    expect(acceptsAnswerAt(afterWord(ANSWER_LIMIT_MS - 1))).toBe(true)
    // 時間切れのあとに届いた正解者は出さない（答えと解説の演出は時間切れのまま）
    expect(acceptsAnswerAt(afterWord(ANSWER_LIMIT_MS))).toBe(false)
  })
})
