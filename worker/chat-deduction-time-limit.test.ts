/**
 * チャットで推理の制限時間の設定（chat-deduction-time-limit.ts）のテスト
 *
 * アプリのページから受け取った制限時間を検証して KV に保存し、ゲームの開始が読み出す。
 * - なし（null）か 5/10/15/20/30分だけを受け付け、それ以外は問題点つきで断る
 * - 未保存ならなし（制限時間を設定にする前と同じく、時間切れで終えない）
 */
import { describe, expect, it } from 'vitest'
import { ConfigError } from './alert-config'
import { loadChatDeductionTimeLimit, parseChatDeductionTimeLimit, saveChatDeductionTimeLimit } from './chat-deduction-time-limit'
import { createFakeStore } from './fake-store'

describe('parseChatDeductionTimeLimit', () => {
  it('選べる分数と、なし（null）を受け付ける', () => {
    expect(parseChatDeductionTimeLimit({ minutes: 10 })).toEqual({ minutes: 10 })
    expect(parseChatDeductionTimeLimit({ minutes: null })).toEqual({ minutes: null })
  })

  it('選べない分数・文字列・項目の無いものは、問題点つきで断る', () => {
    for (const input of [{ minutes: 7 }, { minutes: 0 }, { minutes: '10' }, {}]) {
      expect(() => parseChatDeductionTimeLimit(input)).toThrowError(ConfigError)
    }
  })

  it('オブジェクトでなければ断る', () => {
    expect(() => parseChatDeductionTimeLimit(10)).toThrowError(ConfigError)
  })
})

describe('loadChatDeductionTimeLimit・saveChatDeductionTimeLimit', () => {
  it('未保存ならなし（null）を返す', async () => {
    expect(await loadChatDeductionTimeLimit(createFakeStore())).toEqual({ minutes: null })
  })

  it('保存した制限時間を読み出す', async () => {
    const store = createFakeStore()

    await saveChatDeductionTimeLimit(store, { minutes: 15 })

    expect(await loadChatDeductionTimeLimit(store)).toEqual({ minutes: 15 })
  })
})
