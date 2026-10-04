/**
 * 紹介の文の折り返し（wrap.ts）のテスト
 *
 * 文字の幅は測る関数を差し替えて、1文字を幅1として数える。
 */
import { describe, expect, it } from 'vitest'
import { wrapText } from './wrap'

/** 1文字を幅1として測る */
const countChars = (text: string): number => [...text].length

describe('wrapText', () => {
  it('幅に収まる文はそのまま1行にする', () => {
    expect(wrapText('当別米が名物です。', 10, countChars)).toEqual(['当別米が名物です。'])
  })

  it('幅を超える文は、幅いっぱいで折り返す', () => {
    expect(wrapText('石狩平野の北東部にある町です', 5, countChars)).toEqual(['石狩平野の', '北東部にあ', 'る町です'])
  })

  it('句読点と閉じかっこは行の頭に置かず、前の行の末尾にぶら下げる', () => {
    expect(wrapText('名物は当別米。ほかに「トペッ」も', 6, countChars)).toEqual(['名物は当別米。', 'ほかに「トペ', 'ッ」も'])
  })
})
