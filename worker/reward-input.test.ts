/**
 * チャンネルポイント報酬の入力の検証（reward-input.ts）のテスト
 *
 * 確かめること:
 * - 正しい入力は、Twitchへ送る項目だけの形にして返すこと
 * - Twitchの制約（名前は1〜45文字・必要ポイントは1以上の整数・説明は200文字まで）に合わない入力を拒むこと
 * - 問題点は最初の1件で止めず、すべて集めて返すこと（管理画面で一度に直せるように）
 */
import { describe, expect, it } from 'vitest'
import { ConfigError } from './alert-config'
import { parseRewardInput } from './reward-input'

const validInput = { title: '乾杯する', cost: 500, prompt: 'おつまみも添えて', isEnabled: true, isUserInputRequired: false }

/** 入力を検証し、拒まれたときの問題点を返す（拒まれなければテストを失敗させる） */
const problemsOf = (input: unknown): readonly string[] => {
  try {
    parseRewardInput(input)
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
  throw new Error('入力が拒まれませんでした')
}

describe('parseRewardInput', () => {
  it('正しい入力を、Twitchへ送る項目だけの形にして返す（知らない項目は捨てる）', () => {
    expect(parseRewardInput({ ...validInput, backgroundColor: '#FF0000' })).toEqual(validInput)
  })

  it('説明は空でもよい', () => {
    expect(parseRewardInput({ ...validInput, prompt: '' })).toEqual({ ...validInput, prompt: '' })
  })

  it('名前の前後の空白は取り除く（Twitchの画面で見分けのつかない名前を作らないため）', () => {
    expect(parseRewardInput({ ...validInput, title: '  乾杯する  ' }).title).toBe('乾杯する')
  })

  it('名前が空・空白だけ・46文字以上なら拒む', () => {
    expect(problemsOf({ ...validInput, title: '' })).toEqual([expect.stringContaining('title')])
    expect(problemsOf({ ...validInput, title: '   ' })).toEqual([expect.stringContaining('title')])
    expect(problemsOf({ ...validInput, title: 'あ'.repeat(46) })).toEqual([expect.stringContaining('title')])
  })

  it('名前はちょうど45文字なら受け付ける', () => {
    expect(parseRewardInput({ ...validInput, title: 'あ'.repeat(45) }).title).toBe('あ'.repeat(45))
  })

  it('必要ポイントが1以上の整数でなければ拒む（空欄から届く null も拒む）', () => {
    for (const cost of [0, -1, 1.5, null, '500']) {
      expect(problemsOf({ ...validInput, cost })).toEqual([expect.stringContaining('cost')])
    }
  })

  it('長さは見た目の文字数で数える（絵文字を2文字と数えて、上限内の名前・説明を拒まない）', () => {
    expect(parseRewardInput({ ...validInput, title: '🍺'.repeat(45) }).title).toBe('🍺'.repeat(45))
    expect(parseRewardInput({ ...validInput, prompt: '🎉'.repeat(200) }).prompt).toBe('🎉'.repeat(200))
    expect(problemsOf({ ...validInput, title: '🍺'.repeat(46) })).toEqual([expect.stringContaining('title')])
  })

  it('説明が201文字以上なら拒む', () => {
    expect(problemsOf({ ...validInput, prompt: 'あ'.repeat(201) })).toEqual([expect.stringContaining('prompt')])
  })

  it('有効かどうか・メッセージの入力を求めるかが真偽値でなければ拒む', () => {
    expect(problemsOf({ ...validInput, isEnabled: 'true' })).toEqual([expect.stringContaining('isEnabled')])
    expect(problemsOf({ ...validInput, isUserInputRequired: undefined })).toEqual([expect.stringContaining('isUserInputRequired')])
  })

  it('問題点は最初の1件で止めず、すべて集めて返す', () => {
    expect(problemsOf({ title: '', cost: 0, prompt: 1, isEnabled: null, isUserInputRequired: null })).toHaveLength(5)
  })

  it('入力がオブジェクトでなければ拒む', () => {
    expect(problemsOf(null)).toHaveLength(1)
  })
})
