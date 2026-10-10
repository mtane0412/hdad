/**
 * 漢字クイズの呼び出しの組み立て（kanji-quiz-call.ts）のテスト
 *
 * Worker は問題集（src/kanji-quiz/problems.json）から、動作の設定で選んだ級の問題を1問選ぶ。
 * 同じ配信で出した問題は選ばず、選べる問題が尽きたら黙って重複させずに投げる（issue #301）。
 */
import { describe, expect, it } from 'vitest'
import type { KanjiQuizProblem } from '../src/kanji-quiz/problems'
import { KanjiQuizExhaustedError, pickKanjiQuizProblem } from './kanji-quiz-call'

/** 同じ配信でまだ1問も出していない */
const noneUsed: ReadonlySet<string> = new Set()

/** 6級を2問、5級を1問持つ問題集 */
const problems: readonly KanjiQuizProblem[] = [
  { word: '境内', readings: ['けいだい'], grade: '6', explanation: '神社や寺の敷地の中。' },
  { word: '納屋', readings: ['なや'], grade: '5', explanation: '農具などをしまう小屋。' },
  { word: '仮病', readings: ['けびょう'], grade: '6', explanation: '病気のふりをすること。' },
]

describe('pickKanjiQuizProblem', () => {
  it('選んだ級の問題だけから、乱数の値で1問選ぶ', () => {
    expect(pickKanjiQuizProblem('6', () => 0, noneUsed, problems).word).toBe('境内')
    expect(pickKanjiQuizProblem('6', () => 0.99, noneUsed, problems).word).toBe('仮病')
    expect(pickKanjiQuizProblem('5', () => 0.5, noneUsed, problems).word).toBe('納屋')
  })

  it('その級の問題が無ければ、黙ってほかの級から出さずに投げる', () => {
    expect(() => pickKanjiQuizProblem('1', () => 0, noneUsed, problems)).toThrowError(/1級の問題がありません/)
  })

  it('同じ配信で出した問題は選ばない', () => {
    // 6級の「境内」はもう出したので、乱数が先頭を指しても残りの「仮病」を選ぶ
    expect(pickKanjiQuizProblem('6', () => 0, new Set(['境内']), problems).word).toBe('仮病')
  })

  it('その級の問題を同じ配信ですべて出していれば、黙って重複させずに投げる', () => {
    const pick = () => pickKanjiQuizProblem('6', () => 0, new Set(['境内', '仮病']), problems)

    expect(pick).toThrowError(KanjiQuizExhaustedError)
    expect(pick).toThrowError(/6級の問題は、この配信ですべて出しました（2問）/)
  })

  it('問題集を省けば、リポジトリの問題集から選ぶ（どの級にも問題がある）', () => {
    expect(pickKanjiQuizProblem('pre1', () => 0, noneUsed).grade).toBe('pre1')
  })
})
