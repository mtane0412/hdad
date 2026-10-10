/**
 * 漢字クイズの問題集（problems.json）の形のテスト
 *
 * 正答の判定が配信の強制終了に直結する（issue #293）ので、問題集は配信者が目で確かめたものだけを持ち、
 * 形の誤り（読みにカタカナや空白が混じる・知らない級・同じ熟語の重複）はここで止める。
 * 級はどれを選んでも出題できるよう、すべての級に1問以上あることも確かめる。
 */
import { describe, expect, it } from 'vitest'
import { KANKEN_GRADES } from './grade'
import { readKanjiQuizProblems } from './problems'
import problems from './problems.json'

describe('問題集（problems.json）', () => {
  it('問題集として読める（読みはひらがなだけ・級は既知の値・熟語の重複なし）', () => {
    expect(() => readKanjiQuizProblems(problems)).not.toThrow()
  })

  it('どの級にも1問以上ある（動作の設定でどの級を選んでも出題できる）', () => {
    const read = readKanjiQuizProblems(problems)
    for (const grade of KANKEN_GRADES) {
      expect(read.filter((problem) => problem.grade === grade).length, `${grade} の問題がありません`).toBeGreaterThan(0)
    }
  })
})

describe('readKanjiQuizProblems', () => {
  const valid = { word: '境内', readings: ['けいだい'], grade: '6', explanation: '神社や寺の敷地の中のこと。' }

  it('熟語・読み・級・解説を持つ問題を読む。読みは複数持てる', () => {
    const multiple = { word: '市場', readings: ['いちば', 'しじょう'], grade: '9', explanation: '物を売り買いする場所。' }

    expect(readKanjiQuizProblems([valid, multiple])).toEqual([valid, multiple])
  })

  it('読みにひらがな以外（カタカナ・空白・漢字）が混じっていたら、何番目のどの熟語かを添えて投げる', () => {
    expect(() => readKanjiQuizProblems([{ ...valid, readings: ['ケイダイ'] }])).toThrowError(/0番目（境内）.*ひらがな/)
    expect(() => readKanjiQuizProblems([{ ...valid, readings: ['けい だい'] }])).toThrowError(/ひらがな/)
    expect(() => readKanjiQuizProblems([{ ...valid, readings: ['境だい'] }])).toThrowError(/ひらがな/)
  })

  it('読みが1つも無ければ投げる', () => {
    expect(() => readKanjiQuizProblems([{ ...valid, readings: [] }])).toThrowError(/読み/)
  })

  it('同じ問題に同じ読みが2回あれば投げる（書き間違いの疑い）', () => {
    expect(() => readKanjiQuizProblems([{ ...valid, readings: ['けいだい', 'けいだい'] }])).toThrowError(/読み/)
  })

  it('知らない級（「6級」のような画面の言い方も）なら投げる', () => {
    expect(() => readKanjiQuizProblems([{ ...valid, grade: '6級' }])).toThrowError(/級/)
  })

  it('熟語・解説が空なら投げる', () => {
    expect(() => readKanjiQuizProblems([{ ...valid, word: '' }])).toThrowError(/熟語/)
    expect(() => readKanjiQuizProblems([{ ...valid, explanation: '' }])).toThrowError(/解説/)
  })

  it('同じ熟語が2問あれば、2問目の位置を添えて投げる', () => {
    expect(() => readKanjiQuizProblems([valid, { ...valid, grade: '5' }])).toThrowError(/1番目（境内）.*重複/)
  })

  it('配列でなければ投げる', () => {
    expect(() => readKanjiQuizProblems({ problems: [valid] })).toThrowError(/配列/)
  })
})
