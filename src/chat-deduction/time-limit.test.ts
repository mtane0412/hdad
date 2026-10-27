/**
 * チャットで推理の制限時間（src/chat-deduction/time-limit.ts）のテスト
 *
 * 選べる制限時間（なし・5/10/15/20/30分）の判定、Worker の応答の読み取り、締め切りの時刻の計算、
 * 合成ページに出す残り時間の書き方を確かめる。
 */
import { describe, expect, it } from 'vitest'
import {
  CHAT_DEDUCTION_TIME_LIMIT_MINUTES,
  chatDeductionClosesAtOf,
  formatChatDeductionRemaining,
  isChatDeductionTimeLimitMinutes,
  readChatDeductionTimeLimit,
} from './time-limit'

describe('isChatDeductionTimeLimitMinutes', () => {
  it('なし（null）と、選べる分数だけを受け付ける', () => {
    expect(CHAT_DEDUCTION_TIME_LIMIT_MINUTES).toEqual([5, 10, 15, 20, 30])
    expect(isChatDeductionTimeLimitMinutes(null)).toBe(true)
    for (const minutes of CHAT_DEDUCTION_TIME_LIMIT_MINUTES) expect(isChatDeductionTimeLimitMinutes(minutes)).toBe(true)
  })

  it('一覧に無い分数・文字列・undefined は受け付けない', () => {
    expect(isChatDeductionTimeLimitMinutes(7)).toBe(false)
    expect(isChatDeductionTimeLimitMinutes(0)).toBe(false)
    expect(isChatDeductionTimeLimitMinutes('10')).toBe(false)
    expect(isChatDeductionTimeLimitMinutes(undefined)).toBe(false)
  })
})

describe('readChatDeductionTimeLimit', () => {
  it('Worker が返した設定を読む', () => {
    expect(readChatDeductionTimeLimit({ minutes: 15 })).toEqual({ minutes: 15 })
    expect(readChatDeductionTimeLimit({ minutes: null })).toEqual({ minutes: null })
  })

  it('形が違えば投げる（なしと見せない）', () => {
    expect(() => readChatDeductionTimeLimit({ minutes: 7 })).toThrow('制限時間')
    expect(() => readChatDeductionTimeLimit({})).toThrow('制限時間')
    expect(() => readChatDeductionTimeLimit(null)).toThrow('制限時間')
  })
})

describe('chatDeductionClosesAtOf', () => {
  const startedAt = Date.parse('2026-10-27T12:00:00.000Z')

  it('始めた時刻に制限時間を足した時刻を返す', () => {
    expect(chatDeductionClosesAtOf(10, startedAt)).toBe(Date.parse('2026-10-27T12:10:00.000Z'))
  })

  it('制限時間がなしなら null を返す', () => {
    expect(chatDeductionClosesAtOf(null, startedAt)).toBeNull()
  })
})

describe('formatChatDeductionRemaining', () => {
  it('残りを「分:秒」で、秒は2桁で出す', () => {
    expect(formatChatDeductionRemaining(4 * 60_000 + 32_000)).toBe('4:32')
    expect(formatChatDeductionRemaining(30 * 60_000)).toBe('30:00')
    expect(formatChatDeductionRemaining(5_000)).toBe('0:05')
  })

  it('1秒に満たない端数は切り上げる（0:00 になるのは締め切りを過ぎてから）', () => {
    expect(formatChatDeductionRemaining(59_001)).toBe('1:00')
    expect(formatChatDeductionRemaining(1)).toBe('0:01')
  })

  it('締め切りを過ぎていれば 0:00 にする（負にしない）', () => {
    expect(formatChatDeductionRemaining(0)).toBe('0:00')
    expect(formatChatDeductionRemaining(-3_000)).toBe('0:00')
  })
})
