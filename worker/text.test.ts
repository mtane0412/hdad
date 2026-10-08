/**
 * テキストの検証（text.ts）のテスト
 *
 * 管理画面と下部バーから送られてくるテキスト1件（名前・本文）を検証する parseTextInput について、次の点を確かめる。
 * - 名前は前後の空白を落として受け取り、空・長すぎる・ほかのテキストと同じ名前は拒むこと
 * - 本文は空でもよく、文字数・行数の上限を超えたら切り詰めずに拒むこと（文字数は見た目の1文字ずつ数える）
 * - 問題点は最初の1件で止めずにすべて集めること
 */
import { describe, expect, it } from 'vitest'
import { ConfigError } from './alert-config'
import { MAX_TEXT_BODY_LENGTH, MAX_TEXT_BODY_LINES, MAX_TEXT_NAME_LENGTH, parseTextInput } from './text'

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
    expect(parseTextInput({ name: '  目標  ', body: 'ログイン画面を作り終える' }, [])).toEqual({ name: '目標', body: 'ログイン画面を作り終える' })
  })

  it('本文は空でも受け取る（書くことが無いあいだは空にしておける）', () => {
    expect(parseTextInput({ name: '今やってること', body: '' }, [])).toEqual({ name: '今やってること', body: '' })
  })

  it('本文の改行は上限の行数までそのまま残す', () => {
    const body = Array.from({ length: MAX_TEXT_BODY_LINES }, (_, index) => `${index + 1}行目`).join('\n')
    expect(parseTextInput({ name: '目標', body }, []).body).toBe(body)
  })

  it('名前が空なら拒む', () => {
    expect(problemsOf({ name: '   ', body: '本文' })).toEqual(['name: 名前を入れてください'])
  })

  it('名前が上限の文字数を超えたら拒む', () => {
    expect(problemsOf({ name: 'あ'.repeat(MAX_TEXT_NAME_LENGTH + 1), body: '' })).toEqual([
      `name: 名前は${MAX_TEXT_NAME_LENGTH}文字以内にしてください（いまは${MAX_TEXT_NAME_LENGTH + 1}文字です）`,
    ])
  })

  it('ほかのテキストと同じ名前は拒む（素材の選択欄で見分けられなくなるため）', () => {
    expect(problemsOf({ name: '目標', body: '' }, ['目標', '今やってること'])).toEqual(['name: 「目標」という名前のテキストはもうあります'])
  })

  it('本文が上限の文字数を超えたら、切り詰めずに拒む', () => {
    expect(problemsOf({ name: '目標', body: 'あ'.repeat(MAX_TEXT_BODY_LENGTH + 1) })).toEqual([
      `body: 本文は${MAX_TEXT_BODY_LENGTH}文字以内にしてください（いまは${MAX_TEXT_BODY_LENGTH + 1}文字です）`,
    ])
  })

  it('文字数は見た目の1文字ずつ数える（組み合わせの絵文字も1文字）', () => {
    const family = '👨‍👩‍👧'
    expect(parseTextInput({ name: family.repeat(MAX_TEXT_NAME_LENGTH), body: family.repeat(MAX_TEXT_BODY_LENGTH) }, []).body).toBe(family.repeat(MAX_TEXT_BODY_LENGTH))
  })

  it('本文が上限の行数を超えたら拒む', () => {
    const body = Array.from({ length: MAX_TEXT_BODY_LINES + 1 }, () => '行').join('\n')
    expect(problemsOf({ name: '目標', body })).toEqual([`body: 本文は${MAX_TEXT_BODY_LINES}行以内にしてください（いまは${MAX_TEXT_BODY_LINES + 1}行です）`])
  })

  it('名前と本文の問題点をまとめて返す', () => {
    expect(problemsOf({ name: '', body: 'あ'.repeat(MAX_TEXT_BODY_LENGTH + 1) })).toHaveLength(2)
  })

  it('名前や本文が文字列でなければ拒む', () => {
    expect(problemsOf({ name: 1, body: null })).toEqual(['name: 名前を文字列で指定してください', 'body: 本文を文字列で指定してください'])
  })

  it('オブジェクトでなければ拒む', () => {
    expect(problemsOf('目標')).toEqual(['テキストは { name, body } の形で指定してください'])
  })
})
