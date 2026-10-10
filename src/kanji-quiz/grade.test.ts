/**
 * 漢検の級（grade.ts）のテスト
 *
 * 級は 10級〜1級（準2級・準1級を含む）の12段階で、やさしい順に並べる。画面には「漢検○級」と出す。
 */
import { describe, expect, it } from 'vitest'
import { KANKEN_GRADES, isKankenGrade, kankenGradeLabel } from './grade'

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
