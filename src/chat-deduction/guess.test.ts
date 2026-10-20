/**
 * チャットで推理の解答の照合のテスト（issue #377）
 *
 * 表記を揃えたうえで別名の一覧と完全一致したものだけを正解にすることを確かめる。
 * - 揃えるのは、前後の空白・全角と半角・カタカナとひらがな・中黒などの記号と空白・英字の大文字と小文字
 * - 部分一致や、揃えると空になる解答は正解にしない
 */
import { describe, expect, it } from 'vitest'
import { isCorrectChatDeductionGuess, normalizeChatDeductionGuess } from './guess'
import { CHAT_DEDUCTION_PROBLEMS } from './problem-set'
import type { ChatDeductionProblem } from './problems'

/** 照合を確かめるための問題（別名だけが照合に使われる） */
const problem: ChatDeductionProblem = {
  id: 'leonardo-da-vinci',
  category: 'person',
  answer: 'レオナルド・ダ・ヴィンチ',
  aliases: ['レオナルド・ダ・ヴィンチ', 'ダヴィンチ', 'Leonardo da Vinci'],
  facts: ['イタリアの画家。'],
  explanation: 'イタリアの画家。',
  wikipedia: 'レオナルド・ダ・ヴィンチ',
}

describe('normalizeChatDeductionGuess', () => {
  it.each([
    { name: '前後の空白（全角を含む）を除く', input: '　ダヴィンチ ', expected: 'だゔぃんち' },
    { name: 'カタカナをひらがなに直す', input: 'フジサン', expected: 'ふじさん' },
    { name: '半角カタカナを全角にしてからひらがなに直す', input: 'ﾌｼﾞｻﾝ', expected: 'ふじさん' },
    { name: '全角の英数字を半角の小文字に直す', input: 'ＮＨＫ２', expected: 'nhk2' },
    { name: '中黒・記号・途中の空白を除く', input: 'レオナルド・ダ・ヴィンチ！', expected: 'れおなるどだゔぃんち' },
    { name: '長音符は残す', input: 'コーヒー', expected: 'こーひー' },
  ])('$name', ({ input, expected }) => {
    expect(normalizeChatDeductionGuess(input)).toBe(expected)
  })
})

describe('isCorrectChatDeductionGuess', () => {
  it.each([
    { name: '別名と同じ表記', guess: 'ダヴィンチ' },
    { name: 'ひらがなで書いた解答', guess: 'だゔぃんち' },
    { name: '中黒を省いた解答', guess: 'レオナルドダヴィンチ' },
    { name: '大文字と小文字・空白が違う英字の解答', guess: ' LEONARDO DA VINCI ' },
  ])('$name を正解にする', ({ guess }) => {
    expect(isCorrectChatDeductionGuess(problem, guess)).toBe(true)
  })

  it.each([
    { name: '別名を含むだけの解答（部分一致）', guess: 'ダヴィンチの絵' },
    { name: '別名の一部だけの解答', guess: 'レオナルド' },
    { name: '揃えると空になる解答（記号だけ）', guess: '・！？' },
    { name: '空の解答', guess: '' },
  ])('$name は正解にしない', ({ guess }) => {
    expect(isCorrectChatDeductionGuess(problem, guess)).toBe(false)
  })
})

describe('問題集の別名', () => {
  it.each(CHAT_DEDUCTION_PROBLEMS.map((candidate) => ({ id: candidate.id, aliases: candidate.aliases })))(
    '$id の別名は、表記を揃えても空にならない（だれも当てられない別名を作らない）',
    ({ aliases }) => {
      for (const alias of aliases) expect(normalizeChatDeductionGuess(alias)).not.toBe('')
    },
  )
})
