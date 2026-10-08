/**
 * テキストの入力欄の値の変換（form.ts）のテスト
 *
 * 次の点を確かめる。
 * - Worker が返した問題点（name: ・body: で始まる）を、画面の行として読める文にすること
 * - 問題点を持たない失敗は、理由を1行で出すこと
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../core/api'
import { textFailureLines } from './form'

describe('textFailureLines', () => {
  it('問題点は、項目の名前を画面の言い方にして1行ずつ並べる', () => {
    const error = new ApiError(400, 'invalid-config', 'テキストに問題があります', [
      'name: 「目標」という名前のテキストはもうあります',
      'body: 本文は4行以内にしてください（いまは5行です）',
    ])

    expect(textFailureLines(error)).toEqual([
      'テキストに問題があります。直してから保存し直してください',
      '・名前: 「目標」という名前のテキストはもうあります',
      '・本文: 本文は4行以内にしてください（いまは5行です）',
    ])
  })

  it('問題点を持たない失敗は、理由を1行で出す', () => {
    expect(textFailureLines(new Error('通信に失敗しました'))).toEqual(['通信に失敗しました'])
  })
})
