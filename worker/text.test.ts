/**
 * テキストの検証（text.ts）のテスト
 *
 * 管理画面と下部バーから送られてくるテキスト1件（名前・本文）を検証する parseTextInput について、次の点を確かめる。
 * - 名前は前後の空白を落として受け取り、空・長すぎる・ほかのテキストと同じ名前は拒むこと
 * - 本文は空でもよく、文字数・行数の上限を超えたら切り詰めずに拒むこと（文字数は見た目の1文字ずつ数える）
 * - 問題点は最初の1件で止めずにすべて集めること
 * - 手動／自動の別（mode）と指示文（instruction）を受け取り、自動なら指示文を必須にし、本文は受け取らないこと（issue #295）
 * - LLMが書いた本文も、手で書いた本文と同じ上限で確かめられること（textBodyProblems）
 */
import { describe, expect, it } from 'vitest'
import { ConfigError } from './alert-config'
import { MAX_TEXT_BODY_LENGTH, MAX_TEXT_BODY_LINES, MAX_TEXT_INSTRUCTION_LENGTH, MAX_TEXT_NAME_LENGTH, parseTextInput, textBodyProblems } from './text'

/** 手で書くテキストの、指示文を持たない入力 */
const manual = (name: unknown, body: unknown): Record<string, unknown> => ({ name, mode: 'manual', body, instruction: '' })

/** 問題点の一覧を取り出す（投げなければテストを失敗させる） */
const problemsOf = (input: unknown, otherNames: readonly string[] = []): readonly string[] => {
  try {
    parseTextInput(input, otherNames)
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
  throw new Error('ConfigError を投げませんでした')
}

describe('parseTextInput', () => {
  it('名前と本文を受け取り、名前の前後の空白は落とす', () => {
    expect(parseTextInput(manual('  目標  ', 'ログイン画面を作り終える'), [])).toEqual(manual('目標', 'ログイン画面を作り終える'))
  })

  it('本文は空でも受け取る（書くことが無いあいだは空にしておける）', () => {
    expect(parseTextInput(manual('今やってること', ''), [])).toEqual(manual('今やってること', ''))
  })

  it('本文の改行は上限の行数までそのまま残す', () => {
    const body = Array.from({ length: MAX_TEXT_BODY_LINES }, (_, index) => `${index + 1}行目`).join('\n')
    expect(parseTextInput(manual('目標', body), [])).toEqual(manual('目標', body))
  })

  it('名前が空なら拒む', () => {
    expect(problemsOf(manual('   ', '本文'))).toEqual(['name: 名前を入れてください'])
  })

  it('名前が上限の文字数を超えたら拒む', () => {
    expect(problemsOf(manual('あ'.repeat(MAX_TEXT_NAME_LENGTH + 1), ''))).toEqual([
      `name: 名前は${MAX_TEXT_NAME_LENGTH}文字以内にしてください（いまは${MAX_TEXT_NAME_LENGTH + 1}文字です）`,
    ])
  })

  it('ほかのテキストと同じ名前は拒む（素材の選択欄で見分けられなくなるため）', () => {
    expect(problemsOf(manual('目標', ''), ['目標', '今やってること'])).toEqual(['name: 「目標」という名前のテキストはもうあります'])
  })

  it('本文が上限の文字数を超えたら、切り詰めずに拒む', () => {
    expect(problemsOf(manual('目標', 'あ'.repeat(MAX_TEXT_BODY_LENGTH + 1)))).toEqual([
      `body: 本文は${MAX_TEXT_BODY_LENGTH}文字以内にしてください（いまは${MAX_TEXT_BODY_LENGTH + 1}文字です）`,
    ])
  })

  it('文字数は見た目の1文字ずつ数える（組み合わせの絵文字も1文字）', () => {
    const family = '👨‍👩‍👧'
    const input = manual(family.repeat(MAX_TEXT_NAME_LENGTH), family.repeat(MAX_TEXT_BODY_LENGTH))
    expect(parseTextInput(input, [])).toEqual(input)
  })

  it('本文が上限の行数を超えたら拒む', () => {
    const body = Array.from({ length: MAX_TEXT_BODY_LINES + 1 }, () => '行').join('\n')
    expect(problemsOf(manual('目標', body))).toEqual([`body: 本文は${MAX_TEXT_BODY_LINES}行以内にしてください（いまは${MAX_TEXT_BODY_LINES + 1}行です）`])
  })

  it('名前と本文の問題点をまとめて返す', () => {
    expect(problemsOf(manual('', 'あ'.repeat(MAX_TEXT_BODY_LENGTH + 1)))).toHaveLength(2)
  })

  it('名前や本文が文字列でなければ拒む', () => {
    expect(problemsOf(manual(1, null))).toEqual(['name: 名前を文字列で指定してください', 'body: 本文を文字列で指定してください'])
  })

  it('オブジェクトでなければ拒む', () => {
    expect(problemsOf('目標')).toEqual(['テキストは { name, mode, body, instruction } の形で指定してください'])
  })

  it('手動のテキストも指示文を持ち続けられる（自動へ戻したときにまた使うため）', () => {
    const input = { name: '今やってること', mode: 'manual', body: 'テストを書いている', instruction: 'いまやっている作業を20字で' }
    expect(parseTextInput(input, [])).toEqual(input)
  })

  it('自動のテキストは指示文を前後の空白を落として受け取り、本文は受け取らない（本文はLLMが書くため）', () => {
    expect(parseTextInput({ name: '今やってること', mode: 'auto', body: '手で書いた本文', instruction: '  いまやっている作業を20字で  ' }, [])).toEqual({
      name: '今やってること',
      mode: 'auto',
      instruction: 'いまやっている作業を20字で',
    })
  })

  it('自動のテキストは本文が無くても受け取る', () => {
    expect(parseTextInput({ name: '今やってること', mode: 'auto', instruction: 'いまやっている作業を20字で' }, [])).toEqual({
      name: '今やってること',
      mode: 'auto',
      instruction: 'いまやっている作業を20字で',
    })
  })

  it('自動のテキストに指示文が無ければ拒む（何を書かせるかが決まらないため）', () => {
    expect(problemsOf({ name: '今やってること', mode: 'auto', instruction: '   ' })).toEqual(['instruction: 自動で書き換えるテキストには指示文を入れてください'])
  })

  it('指示文が上限の文字数を超えたら、切り詰めずに拒む', () => {
    expect(problemsOf({ name: '今やってること', mode: 'auto', instruction: 'あ'.repeat(MAX_TEXT_INSTRUCTION_LENGTH + 1) })).toEqual([
      `instruction: 指示文は${MAX_TEXT_INSTRUCTION_LENGTH}文字以内にしてください（いまは${MAX_TEXT_INSTRUCTION_LENGTH + 1}文字です）`,
    ])
  })

  it('手動・自動のどちらでもなければ拒む', () => {
    expect(problemsOf({ name: '目標', mode: 'semi', body: '', instruction: '' })).toEqual(['mode: 手動（manual）か自動（auto）を指定してください'])
  })

  it('指示文が文字列でなければ拒む', () => {
    expect(problemsOf({ name: '目標', mode: 'manual', body: '', instruction: null })).toEqual(['instruction: 指示文を文字列で指定してください'])
  })
})

describe('textBodyProblems', () => {
  it('上限に収まる本文なら問題点を返さない', () => {
    expect(textBodyProblems('ログイン画面のテストを書いている')).toEqual([])
  })

  it('文字数と行数の上限を超えた本文は、どちらも問題点として返す', () => {
    const body = Array.from({ length: MAX_TEXT_BODY_LINES + 1 }, () => 'あ'.repeat(MAX_TEXT_BODY_LENGTH)).join('\n')
    expect(textBodyProblems(body)).toHaveLength(2)
  })
})
