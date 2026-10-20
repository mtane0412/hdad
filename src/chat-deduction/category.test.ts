/**
 * チャットで推理の問題の区分のテスト
 */
import { describe, expect, it } from 'vitest'
import { CHAT_DEDUCTION_CATEGORIES, categoryLabelOf, isChatDeductionCategory, subjectLabelOf } from './category'

describe('問題の区分', () => {
  it('人物・場所・出来事・ものの4つを、識別子と画面の言い方の組で持つ', () => {
    expect(CHAT_DEDUCTION_CATEGORIES.map((category) => [category, categoryLabelOf(category)])).toEqual([
      ['person', '人物'],
      ['place', '場所'],
      ['event', '出来事'],
      ['thing', 'もの'],
    ])
  })

  it('識別子だけを区分として認める（画面の言い方や知らない値は認めない）', () => {
    expect(isChatDeductionCategory('event')).toBe(true)
    expect(isChatDeductionCategory('出来事')).toBe(false)
    expect(isChatDeductionCategory(1)).toBe(false)
  })
})

describe('お題の言い方', () => {
  it('括りがあれば区分の前に添え、無ければ区分だけにする', () => {
    expect(subjectLabelOf('person', '古代史')).toBe('古代史の人物')
    expect(subjectLabelOf('place', null)).toBe('場所')
  })
})
