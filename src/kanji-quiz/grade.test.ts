/**
 * 漢検の級（grade.ts）のテスト
 *
 * 級は 10級〜1級（準2級・準1級を含む）の12段階で、やさしい順に並べる。画面には「漢検○級」と出す。
 * 出題の割合は級ごとの重み（0〜100の整数。0は出さない）で持つ。
 */
import { describe, expect, it } from 'vitest'
import { KANKEN_GRADES, isKankenGrade, isKankenGradeWeights, kankenGradeLabel, singleGradeWeights } from './grade'

describe('KANKEN_GRADES', () => {
  it('10級から1級まで、準2級・準1級を含む12段階をやさしい順に並べる', () => {
    expect(KANKEN_GRADES.map(kankenGradeLabel)).toEqual(['10級', '9級', '8級', '7級', '6級', '5級', '4級', '3級', '準2級', '2級', '準1級', '1級'])
  })
})

describe('kankenGradeLabel', () => {
  it('準のつく級は「準」を前に付けて出す', () => {
    expect(kankenGradeLabel('pre2')).toBe('準2級')
    expect(kankenGradeLabel('pre1')).toBe('準1級')
  })
})

describe('isKankenGrade', () => {
  it('級の一覧にある値だけを級とみなす', () => {
    expect(isKankenGrade('pre2')).toBe(true)
    expect(isKankenGrade('10')).toBe(true)
  })

  it('一覧にない値・文字列でない値は級とみなさない（「準2級」のような画面の言い方も受け付けない）', () => {
    expect(isKankenGrade('準2級')).toBe(false)
    expect(isKankenGrade('11')).toBe(false)
    expect(isKankenGrade(2)).toBe(false)
  })
})

describe('singleGradeWeights', () => {
  it('指定した級だけ重みを1にし、ほかの級は0にする', () => {
    const weights = singleGradeWeights('pre2')

    expect(weights.pre2).toBe(1)
    expect(KANKEN_GRADES.filter((grade) => weights[grade] !== 0)).toEqual(['pre2'])
  })
})

describe('isKankenGradeWeights', () => {
  /** 3級を3、準2級を1にした重み */
  const weights = { ...singleGradeWeights('3'), '3': 3, pre2: 1 }

  it('12の級すべてに0〜100の整数を持ち、1つ以上が1以上なら重みとみなす', () => {
    expect(isKankenGradeWeights(weights)).toBe(true)
    expect(isKankenGradeWeights({ ...weights, '1': 100 })).toBe(true)
  })

  it('すべて0なら、出せる級が無いので重みとみなさない', () => {
    expect(isKankenGradeWeights({ ...weights, '3': 0, pre2: 0 })).toBe(false)
  })

  it('級が欠けている・知らない級がある・負の数・小数・100を超える数・文字列は重みとみなさない', () => {
    // 準1級だけを欠いた重み
    const missingPre1 = Object.fromEntries(Object.entries(weights).filter(([grade]) => grade !== 'pre1'))
    expect(isKankenGradeWeights(missingPre1)).toBe(false)
    expect(isKankenGradeWeights({ ...weights, '準2級': 1 })).toBe(false)
    expect(isKankenGradeWeights({ ...weights, '10': -1 })).toBe(false)
    expect(isKankenGradeWeights({ ...weights, '10': 0.5 })).toBe(false)
    expect(isKankenGradeWeights({ ...weights, '10': 101 })).toBe(false)
    expect(isKankenGradeWeights({ ...weights, '10': '1' })).toBe(false)
    expect(isKankenGradeWeights(null)).toBe(false)
  })
})
