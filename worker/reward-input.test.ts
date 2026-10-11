/**
 * チャンネルポイント報酬の入力の検証（reward-input.ts）のテスト
 *
 * 確かめること:
 * - 正しい入力は、Twitchへ送る項目だけの形にして返すこと
 * - Twitchの制約（名前は1〜45文字・必要ポイントは1以上の整数・説明は200文字まで）に合わない入力を拒むこと
 * - 背景色は #RRGGBB だけを受け付けること
 * - 待機時間・上限回数は null（制限なし）か範囲内の整数だけを受け付けること
 * - 問題点は最初の1件で止めず、すべて集めて返すこと（管理画面で一度に直せるように）
 */
import { describe, expect, it } from 'vitest'
import { ConfigError } from './alert-config'
import { parseRewardInput } from './reward-input'

const validInput = {
  title: '乾杯する',
  cost: 500,
  prompt: 'おつまみも添えて',
  isEnabled: true,
  isUserInputRequired: false,
  backgroundColor: '#9147FF',
  shouldRedemptionsSkipRequestQueue: false,
  maxPerStream: null,
  maxPerUserPerStream: 3,
  globalCooldownSeconds: 300,
}

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
    expect(parseRewardInput({ ...validInput, imageUrl: 'https://static-cdn.jtvnw.net/custom-reward-images/default-2.png' })).toEqual(validInput)
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

  it('背景色は #RRGGBB の形だけを受け付ける（大文字・小文字は問わない）', () => {
    expect(parseRewardInput({ ...validInput, backgroundColor: '#00e5cb' }).backgroundColor).toBe('#00e5cb')
    for (const backgroundColor of ['9147FF', '#FFF', '#9147FG', 'purple', null]) {
      expect(problemsOf({ ...validInput, backgroundColor })).toEqual([expect.stringContaining('backgroundColor')])
    }
  })

  it('待ち行列に入れずに完了にするかが真偽値でなければ拒む', () => {
    expect(problemsOf({ ...validInput, shouldRedemptionsSkipRequestQueue: undefined })).toEqual([expect.stringContaining('shouldRedemptionsSkipRequestQueue')])
  })

  it('上限回数は null（制限なし）か1以上の整数だけを受け付ける', () => {
    expect(parseRewardInput({ ...validInput, maxPerStream: 10, maxPerUserPerStream: null })).toMatchObject({ maxPerStream: 10, maxPerUserPerStream: null })
    for (const limit of [0, -1, 1.5, '3', undefined]) {
      expect(problemsOf({ ...validInput, maxPerStream: limit })).toEqual([expect.stringContaining('maxPerStream')])
      expect(problemsOf({ ...validInput, maxPerUserPerStream: limit })).toEqual([expect.stringContaining('maxPerUserPerStream')])
    }
  })

  it('待機時間は null（制限なし）か60〜604800秒の整数だけを受け付ける（60秒未満はTwitchの画面に出ないため）', () => {
    expect(parseRewardInput({ ...validInput, globalCooldownSeconds: null }).globalCooldownSeconds).toBeNull()
    expect(parseRewardInput({ ...validInput, globalCooldownSeconds: 60 }).globalCooldownSeconds).toBe(60)
    expect(parseRewardInput({ ...validInput, globalCooldownSeconds: 604800 }).globalCooldownSeconds).toBe(604800)
    for (const globalCooldownSeconds of [59, 604801, 90.5, '300', undefined]) {
      expect(problemsOf({ ...validInput, globalCooldownSeconds })).toEqual([expect.stringContaining('globalCooldownSeconds')])
    }
  })

  it('問題点は最初の1件で止めず、すべて集めて返す', () => {
    expect(
      problemsOf({
        title: '',
        cost: 0,
        prompt: 1,
        isEnabled: null,
        isUserInputRequired: null,
        backgroundColor: '',
        shouldRedemptionsSkipRequestQueue: null,
        maxPerStream: 0,
        maxPerUserPerStream: 0,
        globalCooldownSeconds: 0,
      }),
    ).toHaveLength(10)
  })

  it('入力がオブジェクトでなければ拒む', () => {
    expect(problemsOf(null)).toHaveLength(1)
  })
})
