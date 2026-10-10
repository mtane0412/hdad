/**
 * 漢字クイズの回答の読み取り（kanji-quiz-answer.ts）のテスト
 *
 * チャットの発言を、前後の空白を除きカタカナをひらがなに直してから、問題集の読みのいずれかと完全一致で照らす。
 * 部分一致とローマ字は受けない。一致した読みを持つ熟語を返し、どれにも一致しなければ空にする
 * （空なら Webhook は D1 を読まない）。
 */
import { describe, expect, it } from 'vitest'
import type { KanjiQuizProblem } from '../src/kanji-quiz/problems'
import { normalizeKanjiQuizAnswer, wordsAnsweredBy } from './kanji-quiz-answer'

/** 読みが1つの問題・読みが2つの問題・長音符を含む問題と、読みが同じ別の熟語を持つ問題集 */
const problems: readonly KanjiQuizProblem[] = [
  { word: '境内', readings: ['けいだい'], grade: '6', explanation: '神社や寺の敷地の中。' },
  { word: '市場', readings: ['いちば', 'しじょう'], grade: '9', explanation: '物を売り買いする場所。' },
  { word: '試乗', readings: ['しじょう'], grade: '6', explanation: '乗り物に試しに乗ること。' },
]

describe('normalizeKanjiQuizAnswer', () => {
  it('前後の空白（全角の空白を含む）を除き、カタカナをひらがなに直す', () => {
    expect(normalizeKanjiQuizAnswer('　ケイダイ ')).toBe('けいだい')
    expect(normalizeKanjiQuizAnswer('ヴァイオリン')).toBe('ゔぁいおりん')
  })

  it('長音符はそのまま残す', () => {
    expect(normalizeKanjiQuizAnswer('ラーメン')).toBe('らーめん')
  })
})

describe('wordsAnsweredBy', () => {
  it('問題集の読みと完全に一致した発言なら、その読みを持つ熟語を返す', () => {
    expect(wordsAnsweredBy('けいだい', problems)).toEqual(['境内'])
    expect(wordsAnsweredBy('いちば', problems)).toEqual(['市場'])
  })

  it('カタカナで書いた回答も、ひらがなの読みとして照らす', () => {
    expect(wordsAnsweredBy('ケイダイ', problems)).toEqual(['境内'])
  })

  it('同じ読みを持つ熟語が複数あれば、すべて返す（どれを出題中かは D1 が決める）', () => {
    expect(wordsAnsweredBy('しじょう', problems)).toEqual(['市場', '試乗'])
  })

  it('部分一致・ローマ字・読み以外の言葉を添えた発言は回答とみなさない', () => {
    expect(wordsAnsweredBy('けいだいかな', problems)).toEqual([])
    expect(wordsAnsweredBy('けい', problems)).toEqual([])
    expect(wordsAnsweredBy('keidai', problems)).toEqual([])
    expect(wordsAnsweredBy('境内', problems)).toEqual([])
  })

  it('問題集を省けば、リポジトリの問題集の読みと照らす', () => {
    expect(wordsAnsweredBy('こんにちは')).toEqual([])
  })
})
