/**
 * 漢字クイズの配信終了までの時間切れの回数（miss-limit.ts）のテスト
 *
 * 1配信のうちに時間切れ（誰も正解できない）が何回になったら配信を止めるかを、1〜上限の整数で持つ。
 * Worker の保存時の検証と、管理画面の応答の読み取りが同じ判定を通す。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_KANJI_QUIZ_MISS_LIMIT, KANJI_QUIZ_MISS_LIMITS, isKanjiQuizMissLimit, readKanjiQuizMissLimit } from './miss-limit'

describe('isKanjiQuizMissLimit', () => {
  it('1〜10の整数を回数として受け付ける', () => {
    expect(isKanjiQuizMissLimit(1)).toBe(true)
    expect(isKanjiQuizMissLimit(3)).toBe(true)
    expect(isKanjiQuizMissLimit(10)).toBe(true)
  })

  it('0以下・上限を超える数・小数・数でない値は受け付けない', () => {
    expect(isKanjiQuizMissLimit(0)).toBe(false)
    expect(isKanjiQuizMissLimit(11)).toBe(false)
    expect(isKanjiQuizMissLimit(2.5)).toBe(false)
    expect(isKanjiQuizMissLimit('3')).toBe(false)
    expect(isKanjiQuizMissLimit(null)).toBe(false)
  })
})

describe('KANJI_QUIZ_MISS_LIMITS', () => {
  it('選べる回数を1から10まで小さい順に並べる（管理画面の選択肢）', () => {
    expect(KANJI_QUIZ_MISS_LIMITS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })
})

describe('DEFAULT_KANJI_QUIZ_MISS_LIMIT', () => {
  it('未保存なら、これまでどおり1回の時間切れで配信を止める', () => {
    expect(DEFAULT_KANJI_QUIZ_MISS_LIMIT).toBe(1)
  })
})

describe('readKanjiQuizMissLimit', () => {
  it('{ missLimit } の形を読む', () => {
    expect(readKanjiQuizMissLimit({ missLimit: 3 })).toEqual({ missLimit: 3 })
  })

  it('回数が範囲の外・形が違えば投げる', () => {
    expect(() => readKanjiQuizMissLimit({ missLimit: 0 })).toThrowError(/回数/)
    expect(() => readKanjiQuizMissLimit(3)).toThrowError(/回数/)
  })
})
