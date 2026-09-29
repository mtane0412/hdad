/**
 * 差し込み語の組み立て（placeholder.ts）のテスト
 *
 * ボタンで入れた差し込み語が、手で打ったときと同じ位置に入ることを確かめる。
 */
import { describe, expect, it } from 'vitest'
import { insertPlaceholder } from './placeholder'

describe('insertPlaceholder', () => {
  it('カーソルの位置に差し込み語を入れ、その後ろにカーソルを置く', () => {
    expect(insertPlaceholder('ありがとう', '{user}', 5, 5)).toEqual({ value: 'ありがとう{user}', cursor: 11 })
  })

  it('文の途中のカーソルにも入れられる', () => {
    expect(insertPlaceholder('ありがとう', '{user}', 0, 0)).toEqual({ value: '{user}ありがとう', cursor: 6 })
  })

  it('選んである範囲は差し込み語で置き換える', () => {
    expect(insertPlaceholder('だれかさん、ありがとう', '{user}', 0, 5)).toEqual({ value: '{user}、ありがとう', cursor: 6 })
  })
})
