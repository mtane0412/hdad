/**
 * 漢字クイズの呼び出しの組み立て（kanji-quiz-call.ts）のテスト
 *
 * Worker は問題集（src/kanji-quiz/problems.json）から、動作の設定で選んだ級の問題を1問選び、
 * 交換した人の名前と一緒に合成ページの素材「漢字クイズ」へ押し出す。
 * 押し出す形は、合成ページの読み取り（src/kanji-quiz/call.ts の parseKanjiQuizCall）がそのまま受け取れる形にする。
 */
import { describe, expect, it } from 'vitest'
import { parseKanjiQuizCall } from '../src/kanji-quiz/call'
import type { KanjiQuizProblem } from '../src/kanji-quiz/problems'
import { demoKanjiQuizCallOf, kanjiQuizCallOf, pickKanjiQuizProblem } from './kanji-quiz-call'

/** 6級を2問、5級を1問持つ問題集 */
const problems: readonly KanjiQuizProblem[] = [
  { word: '境内', readings: ['けいだい'], grade: '6', explanation: '神社や寺の敷地の中。' },
  { word: '納屋', readings: ['なや'], grade: '5', explanation: '農具などをしまう小屋。' },
  { word: '仮病', readings: ['けびょう'], grade: '6', explanation: '病気のふりをすること。' },
]

describe('pickKanjiQuizProblem', () => {
  it('選んだ級の問題だけから、乱数の値で1問選ぶ', () => {
    expect(pickKanjiQuizProblem('6', () => 0, problems).word).toBe('境内')
    expect(pickKanjiQuizProblem('6', () => 0.99, problems).word).toBe('仮病')
    expect(pickKanjiQuizProblem('5', () => 0.5, problems).word).toBe('納屋')
  })

  it('その級の問題が無ければ、黙ってほかの級から出さずに投げる', () => {
    expect(() => pickKanjiQuizProblem('1', () => 0, problems)).toThrowError(/1級の問題がありません/)
  })

  it('問題集を省けば、リポジトリの問題集から選ぶ（どの級にも問題がある）', () => {
    expect(pickKanjiQuizProblem('pre1', () => 0).grade).toBe('pre1')
  })
})

describe('kanjiQuizCallOf', () => {
  it('問題と交換した人の名前から呼び出しを作り、合成ページの読み取りがそのまま読める', () => {
    const problem = problems[0]
    if (problem === undefined) throw new Error('問題がありません')
    const call = kanjiQuizCallOf(problem, '田中太郎', '呼び出しID')

    expect(call).toEqual({ id: '呼び出しID', problem, requesterName: '田中太郎' })
    expect(parseKanjiQuizCall(JSON.stringify(call))).toEqual(call)
  })
})

describe('demoKanjiQuizCallOf', () => {
  it('試し再生は出題させた人を持たない', () => {
    const problem = problems[1]
    if (problem === undefined) throw new Error('問題がありません')

    expect(demoKanjiQuizCallOf(problem, '呼び出しID')).toEqual({ id: '呼び出しID', problem, requesterName: null })
  })
})
