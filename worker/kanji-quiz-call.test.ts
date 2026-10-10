/**
 * 漢字クイズの呼び出しの組み立て（kanji-quiz-call.ts）のテスト
 *
 * Worker は問題集（src/kanji-quiz/problems.json）から、動作の設定の級ごとの重みに沿って級を選び、その級の問題を1問選ぶ。
 * 同じ配信で出した問題は選ばず、出し終えた級は外して残りの級の重みで選ぶ。重みのある級をすべて出し終えたら、
 * 出した回数がいちばん少ない問題から選び直す（一巡する）。
 */
import { describe, expect, it } from 'vitest'
import { singleGradeWeights } from '../src/kanji-quiz/grade'
import type { KanjiQuizProblem } from '../src/kanji-quiz/problems'
import { pickKanjiQuizProblem } from './kanji-quiz-call'

/** 同じ配信でまだ1問も出していない */
const noneUsed: ReadonlyMap<string, number> = new Map()

/** 6級を2問、5級を1問持つ問題集 */
const problems: readonly KanjiQuizProblem[] = [
  { word: '境内', readings: ['けいだい'], grade: '6', explanation: '神社や寺の敷地の中。' },
  { word: '納屋', readings: ['なや'], grade: '5', explanation: '農具などをしまう小屋。' },
  { word: '仮病', readings: ['けびょう'], grade: '6', explanation: '病気のふりをすること。' },
]

/** 6級を3、5級を1の割合で出す重み（6級が75%、5級が25%） */
const sixHeavy = { ...singleGradeWeights('6'), '6': 3, '5': 1 }

/** 渡した値を順に返す乱数（1回目で級、2回目で問題を選ぶ） */
const sequence = (...values: number[]) => {
  const queue = [...values]
  return () => {
    const value = queue.shift()
    if (value === undefined) throw new Error('乱数を用意した回数より多く引きました')
    return value
  }
}

describe('pickKanjiQuizProblem', () => {
  it('級を重みの割合で選んでから、その級の問題を乱数の値で1問選ぶ', () => {
    // 0〜0.75 未満は6級、0.75 以上は5級
    expect(pickKanjiQuizProblem(sixHeavy, sequence(0, 0), noneUsed, problems).word).toBe('境内')
    expect(pickKanjiQuizProblem(sixHeavy, sequence(0.74, 0.99), noneUsed, problems).word).toBe('仮病')
    expect(pickKanjiQuizProblem(sixHeavy, sequence(0.75, 0), noneUsed, problems).word).toBe('納屋')
  })

  it('重みが0の級からは出さない', () => {
    expect(pickKanjiQuizProblem(singleGradeWeights('5'), sequence(0, 0), noneUsed, problems).word).toBe('納屋')
  })

  it('重みのある級の問題が問題集に無ければ、黙ってほかの級から出さずに投げる', () => {
    expect(() => pickKanjiQuizProblem({ ...sixHeavy, '1': 1 }, sequence(0, 0), noneUsed, problems)).toThrowError(/1級の問題がありません/)
  })

  it('同じ配信で出した問題は選ばない', () => {
    // 6級の「境内」はもう出したので、乱数が先頭を指しても残りの「仮病」を選ぶ
    expect(pickKanjiQuizProblem(sixHeavy, sequence(0, 0), new Map([['境内', 1]]), problems).word).toBe('仮病')
  })

  it('出し終えた級は外し、残りの級の重みで選ぶ', () => {
    // 6級は2問とも出したので、乱数が6級の範囲を指しても5級から出す
    const used = new Map([
      ['境内', 1],
      ['仮病', 1],
    ])

    expect(pickKanjiQuizProblem(sixHeavy, sequence(0, 0), used, problems).word).toBe('納屋')
  })

  it('重みのある級をすべて出し終えたら、エラーにせず出した回数がいちばん少ない問題から選び直す', () => {
    // 3問とも1回ずつ出したので、2巡目として全問から選ぶ
    const allOnce = new Map([
      ['境内', 1],
      ['納屋', 1],
      ['仮病', 1],
    ])
    expect(pickKanjiQuizProblem(sixHeavy, sequence(0, 0), allOnce, problems).word).toBe('境内')

    // 2巡目で「境内」だけ2回出したので、6級からは「仮病」を選ぶ
    const keidaiTwice = new Map([...allOnce, ['境内', 2]])
    expect(pickKanjiQuizProblem(sixHeavy, sequence(0, 0), keidaiTwice, problems).word).toBe('仮病')
  })

  it('問題集を省けば、リポジトリの問題集から選ぶ（どの級にも問題がある）', () => {
    expect(pickKanjiQuizProblem(singleGradeWeights('pre1'), sequence(0, 0), noneUsed).grade).toBe('pre1')
  })
})
