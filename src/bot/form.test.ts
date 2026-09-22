/**
 * コマンドの入力欄の値の変換（form.ts）のテスト
 *
 * 入力欄の値は文字列なので、保存の形（数値を含む）との間で変換する。
 * 送る前にここで弾くのは「数値として読めない」場合だけで、範囲などの検証はWorkerが行う。
 */
import { describe, expect, it } from 'vitest'
import {
  describeProblem,
  toCommandInput,
  toDraft,
  toModerationRuleDraft,
  toModerationRuleInput,
  type CommandDraft,
  type ModerationRuleDraft,
} from './form'

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

describe('toModerationRuleDraft', () => {
  it('禁止語のルールを、入力欄の値にする', () => {
    expect(toModerationRuleDraft({ kind: 'word', word: '宣伝', punishment: { type: 'timeout', durationSeconds: 600 } })).toEqual({
      kind: 'word',
      word: '宣伝',
      count: '3',
      windowSeconds: '30',
      punishmentType: 'timeout',
      durationSeconds: '600',
    })
  })

  it('連投のルールを、入力欄の値にする（使わない欄は既定の値のまま）', () => {
    expect(toModerationRuleDraft({ kind: 'repeat', count: 5, windowSeconds: 60, punishment: { type: 'ban' } })).toEqual({
      kind: 'repeat',
      word: '',
      count: '5',
      windowSeconds: '60',
      punishmentType: 'ban',
      durationSeconds: '600',
    })
  })
})

describe('toModerationRuleInput', () => {
  const 入力 = (上書き: Partial<ModerationRuleDraft> = {}): ModerationRuleDraft => ({
    kind: 'word',
    word: '宣伝',
    count: '3',
    windowSeconds: '30',
    punishmentType: 'delete',
    durationSeconds: '600',
    ...上書き,
  })

  it('禁止語のルールでは、語句と処分だけを送る', () => {
    expect(toModerationRuleInput(入力())).toEqual({ kind: 'word', word: '宣伝', punishment: { type: 'delete' } })
  })

  it('語句の前後の空白は取り除く', () => {
    expect(toModerationRuleInput(入力({ word: '  宣伝  ' }))).toEqual({ kind: 'word', word: '宣伝', punishment: { type: 'delete' } })
  })

  it('URLのルールでは、語句を送らない', () => {
    expect(toModerationRuleInput(入力({ kind: 'url' }))).toEqual({ kind: 'url', punishment: { type: 'delete' } })
  })

  it('連投のルールでは、回数と秒数を数値にして送る', () => {
    expect(toModerationRuleInput(入力({ kind: 'repeat', count: '5', windowSeconds: '60' }))).toEqual({
      kind: 'repeat',
      count: 5,
      windowSeconds: 60,
      punishment: { type: 'delete' },
    })
  })

  it('タイムアウトの処分では、長さを数値にして送る', () => {
    expect(toModerationRuleInput(入力({ punishmentType: 'timeout', durationSeconds: '600' }))).toMatchObject({
      punishment: { type: 'timeout', durationSeconds: 600 },
    })
  })

  it('数値として読めない入力はエラーにする', () => {
    expect(() => toModerationRuleInput(入力({ kind: 'repeat', count: 'さんかい' }))).toThrow()
  })
})

describe('describeProblem（自動モデレーション）', () => {
  it('Workerが返した問題点の rules[0] を、何番目のルールかに言い換える', () => {
    expect(describeProblem('rules[0].word: 100文字以内の語句を入力してください')).toBe('1番目のルール word: 100文字以内の語句を入力してください')
  })
})
