/**
 * コマンドの入力欄の値の変換（form.ts）のテスト
 *
 * 入力欄の値は文字列なので、保存の形（数値を含む）との間で変換する。
 * 送る前にここで弾くのは「数値として読めない」場合だけで、範囲などの検証はWorkerが行う。
 */
import { describe, expect, it } from 'vitest'
import { describeProblem, toCommandInput, toDraft, type CommandDraft } from './form'

const 挨拶のコマンド = { name: 'aisatsu', reply: '@{user} こんばんは', cooldownSeconds: 10 }
const 挨拶の入力 : CommandDraft = { name: 'aisatsu', reply: '@{user} こんばんは', cooldownSeconds: '10' }

describe('toDraft', () => {
  it('保存済みのコマンドを、入力欄の値にする', () => {
    expect(toDraft(挨拶のコマンド)).toEqual(挨拶の入力)
  })
})

describe('toCommandInput', () => {
  it('入力欄の値を、保存する形にする', () => {
    expect(toCommandInput(挨拶の入力)).toEqual(挨拶のコマンド)
  })

  it('クールダウンが空欄なら0として扱う（毎回応答する）', () => {
    expect(toCommandInput({ ...挨拶の入力, cooldownSeconds: '' }).cooldownSeconds).toBe(0)
  })

  it('コマンド名の前後の空白は取り除く（貼り付けたときに紛れ込むため）', () => {
    expect(toCommandInput({ ...挨拶の入力, name: '  aisatsu  ' }).name).toBe('aisatsu')
  })

  it('コマンド名の先頭の ! は取り除く（入力時に付けてしまいがちなため）', () => {
    expect(toCommandInput({ ...挨拶の入力, name: '!aisatsu' }).name).toBe('aisatsu')
  })

  it('クールダウンが数値として読めなければエラーにする', () => {
    expect(() => toCommandInput({ ...挨拶の入力, cooldownSeconds: 'じゅうびょう' })).toThrow('クールダウン')
  })
})

describe('describeProblem', () => {
  it('Workerが返した問題点の commands[0] を、何番目のコマンドかに言い換える', () => {
    expect(describeProblem('commands[0].name: 空白と ! を含まない50文字以内の文字列で指定してください')).toBe(
      '1番目のコマンド name: 空白と ! を含まない50文字以内の文字列で指定してください',
    )
  })

  it('コマンドに紐づかない問題点は、そのまま返す', () => {
    expect(describeProblem('commands: 配列で指定してください')).toBe('commands: 配列で指定してください')
  })
})
