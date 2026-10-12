/**
 * 漢字クイズの回答の読み方（answer.ts）のテスト
 *
 * チャットの発言を、前後の空白を除きカタカナをひらがなに直してから読む（Worker の正解の照合と合成ページの不正解の判定が同じ直し方を通す）。
 * 合成ページは、ひらがな・カタカナ（と長音符）だけの短い発言を回答とみなし、出題中の熟語の読みと一致しなければ「直前の回答」として出す。
 */
import { describe, expect, it } from 'vitest'
import { normalizeKanjiQuizAnswer, wrongKanjiQuizAnswerOf } from './answer'

describe('normalizeKanjiQuizAnswer', () => {
  it('前後の空白（全角の空白を含む）を除き、カタカナをひらがなに直す', () => {
    expect(normalizeKanjiQuizAnswer('　ケイダイ ')).toBe('けいだい')
    expect(normalizeKanjiQuizAnswer('ヴァイオリン')).toBe('ゔぁいおりん')
  })

  it('長音符はそのまま残す', () => {
    expect(normalizeKanjiQuizAnswer('ラーメン')).toBe('らーめん')
  })
})

describe('wrongKanjiQuizAnswerOf', () => {
  /** 出題中の「市場」の正解の読み */
  const ichibaReadings = ['いちば', 'しじょう']

  it('ひらがなだけの発言が正解の読みと違えば、前後の空白を除いた発言を不正解の回答として返す', () => {
    expect(wrongKanjiQuizAnswerOf(' いちじょう ', ichibaReadings)).toBe('いちじょう')
  })

  it('カタカナ・長音符の発言も回答とみなし、書かれたままの形で返す', () => {
    expect(wrongKanjiQuizAnswerOf('シーバ', ichibaReadings)).toBe('シーバ')
  })

  it('正解の読みと一致する発言は不正解にしない（カタカナで書いた正解も同じ）', () => {
    expect(wrongKanjiQuizAnswerOf('いちば', ichibaReadings)).toBeNull()
    expect(wrongKanjiQuizAnswerOf('シジョウ', ichibaReadings)).toBeNull()
  })

  it('漢字・英数字・記号・空白を含む発言は回答とみなさない（雑談を不正解として出さない）', () => {
    expect(wrongKanjiQuizAnswerOf('難しいね', ichibaReadings)).toBeNull()
    expect(wrongKanjiQuizAnswerOf('ichiba', ichibaReadings)).toBeNull()
    expect(wrongKanjiQuizAnswerOf('いちば？', ichibaReadings)).toBeNull()
    expect(wrongKanjiQuizAnswerOf('いち ば', ichibaReadings)).toBeNull()
    expect(wrongKanjiQuizAnswerOf('　', ichibaReadings)).toBeNull()
  })

  it('長すぎる発言（21文字以上）は回答とみなさない', () => {
    expect(wrongKanjiQuizAnswerOf('あ'.repeat(20), ichibaReadings)).toBe('あ'.repeat(20))
    expect(wrongKanjiQuizAnswerOf('あ'.repeat(21), ichibaReadings)).toBeNull()
  })
})
