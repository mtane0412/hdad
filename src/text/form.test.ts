/**
 * テキストの入力欄の値の変換（form.ts）のテスト
 *
 * 次の点を確かめる。
 * - Worker が返した問題点（name: ・body: で始まる）を、画面の行として読める文にすること
 * - 問題点を持たない失敗は、理由を1行で出すこと
 * - 入力欄の中身（書きかけ）を、Worker へ送る形にすること（自動なら本文を送らない。issue #295）
 * - 書きかけの本文を書き換えたら手動にすること（自動の最中に手で書き換えたら手動に切り替える）
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../core/api'
import type { TextEntry } from './entry'
import { draftOf, editBody, textFailureLines, toTextInput, type TextDraft } from './form'

describe('textFailureLines', () => {
  it('問題点は、項目の名前を画面の言い方にして1行ずつ並べる', () => {
    const error = new ApiError(400, 'invalid-config', 'テキストに問題があります', [
      'name: 「目標」という名前のテキストはもうあります',
      'body: 本文は4行以内にしてください（いまは5行です）',
      'instruction: 自動で書き換えるテキストには指示文を入れてください',
    ])

    expect(textFailureLines(error)).toEqual([
      'テキストに問題があります。直してから保存し直してください',
      '・名前: 「目標」という名前のテキストはもうあります',
      '・本文: 本文は4行以内にしてください（いまは5行です）',
      '・指示文: 自動で書き換えるテキストには指示文を入れてください',
    ])
  })

  it('問題点を持たない失敗は、理由を1行で出す', () => {
    expect(textFailureLines(new Error('通信に失敗しました'))).toEqual(['通信に失敗しました'])
  })
})

const doing: TextEntry = {
  id: 3,
  name: '今やってること',
  body: 'ログイン画面のテストを書いている',
  mode: 'auto',
  instruction: 'いまやっている作業を20字で',
  writtenBy: 'llm',
  updatedAt: '2026-10-08T12:10:00.000Z',
}

describe('draftOf', () => {
  it('保存済みのテキストから、入力欄の中身を作る', () => {
    expect(draftOf(doing)).toEqual({ name: '今やってること', mode: 'auto', body: 'ログイン画面のテストを書いている', instruction: 'いまやっている作業を20字で' })
  })
})

describe('toTextInput', () => {
  const draft: TextDraft = { name: '今やってること', mode: 'manual', body: 'テストを書いている', instruction: 'いまやっている作業を20字で' }

  it('手動なら本文と指示文を送る', () => {
    expect(toTextInput(draft)).toEqual(draft)
  })

  it('自動なら本文を送らない（本文は LLM が書くので、画面が読み込んだときの古い本文で上書きしないため）', () => {
    expect(toTextInput({ ...draft, mode: 'auto' })).toEqual({ name: '今やってること', mode: 'auto', instruction: 'いまやっている作業を20字で' })
  })
})

describe('editBody', () => {
  it('本文を書き換えたら、自動でも手動に切り替える', () => {
    expect(editBody(draftOf(doing), '休憩中')).toEqual({ name: '今やってること', mode: 'manual', body: '休憩中', instruction: 'いまやっている作業を20字で' })
  })
})
