/**
 * 漢字クイズの場面（scene.ts）のテスト
 *
 * 出題の演出は、流しはじめてからの経過時間だけから決まる（フレーム間の状態を持たない）。
 * 「漢検○級」→ 熟語が奥から近づく → 制限時間（最後の5秒は大きなカウントダウン）→ 時間切れで正解の読みと解説、の順に進む。
 */
import { describe, expect, it } from 'vitest'
import { ANSWER_LIMIT_MS, APPROACH_MS, COUNTDOWN_SECONDS, GRADE_INTRO_MS, KANJI_QUIZ_TOTAL_MS, REVEAL_MS, kanjiQuizSceneAt } from './scene'

/** 熟語が出てからの経過時間を、流しはじめてからの経過時間にする */
const afterWord = (ms: number): number => GRADE_INTRO_MS + ms

describe('kanjiQuizSceneAt', () => {
  it('はじめは級を出す', () => {
    expect(kanjiQuizSceneAt(0)).toMatchObject({ kind: 'grade' })
    expect(kanjiQuizSceneAt(GRADE_INTRO_MS - 1)).toMatchObject({ kind: 'grade' })
  })

  it('級のあとは熟語を小さく出し、近づき終えたら等倍にする', () => {
    const appeared = kanjiQuizSceneAt(afterWord(0))
    const halfway = kanjiQuizSceneAt(afterWord(APPROACH_MS / 2))
    const arrived = kanjiQuizSceneAt(afterWord(APPROACH_MS))

    if (appeared.kind !== 'question' || halfway.kind !== 'question' || arrived.kind !== 'question') throw new Error('出題の場面ではありません')
    expect(appeared.wordScale).toBeLessThan(0.1)
    expect(halfway.wordScale).toBeGreaterThan(appeared.wordScale)
    expect(halfway.wordScale).toBeLessThan(1)
    expect(arrived.wordScale).toBe(1)
  })

  it('残り秒数は熟語が出たときから数え、切り上げて出す', () => {
    expect(kanjiQuizSceneAt(afterWord(0))).toMatchObject({ kind: 'question', remainingSeconds: ANSWER_LIMIT_MS / 1000 })
    expect(kanjiQuizSceneAt(afterWord(ANSWER_LIMIT_MS - 1))).toMatchObject({ kind: 'question', remainingSeconds: 1 })
  })

  it('最後の5秒だけ大きなカウントダウンにする', () => {
    const countdownStartsAt = ANSWER_LIMIT_MS - COUNTDOWN_SECONDS * 1000

    expect(kanjiQuizSceneAt(afterWord(countdownStartsAt - 1))).toMatchObject({ kind: 'question', countdown: false, remainingSeconds: COUNTDOWN_SECONDS + 1 })
    expect(kanjiQuizSceneAt(afterWord(countdownStartsAt))).toMatchObject({ kind: 'question', countdown: true, remainingSeconds: COUNTDOWN_SECONDS })
  })

  it('制限時間を過ぎたら、正解の読みと解説を出す場面にする', () => {
    expect(kanjiQuizSceneAt(afterWord(ANSWER_LIMIT_MS))).toMatchObject({ kind: 'reveal' })
    expect(kanjiQuizSceneAt(afterWord(ANSWER_LIMIT_MS + REVEAL_MS - 1))).toMatchObject({ kind: 'reveal' })
  })

  it('解説を出し終えたら終わる', () => {
    expect(KANJI_QUIZ_TOTAL_MS).toBe(GRADE_INTRO_MS + ANSWER_LIMIT_MS + REVEAL_MS)
    expect(kanjiQuizSceneAt(KANJI_QUIZ_TOTAL_MS)).toEqual({ kind: 'done' })
  })

  it('各場面の進み具合は 0〜1 にする（出だしのふわっとした出し方に使う）', () => {
    expect(kanjiQuizSceneAt(GRADE_INTRO_MS / 2)).toEqual({ kind: 'grade', progress: 0.5 })
    expect(kanjiQuizSceneAt(afterWord(ANSWER_LIMIT_MS + REVEAL_MS / 4))).toEqual({ kind: 'reveal', progress: 0.25 })
  })
})
