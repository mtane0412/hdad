/**
 * チャットで推理の報酬のIDの読み取り（worker/chat-deduction-rewards.ts）のテスト
 *
 * 控えたIDが読めなければ、作っていないことにせず投げる（作り直させると、同じ名前の報酬があるとしてTwitchに断られるため）。
 */
import { describe, expect, it } from 'vitest'
import { loadChatDeductionRewards } from './chat-deduction-rewards'
import { createFakeStore } from './fake-store'

describe('loadChatDeductionRewards', () => {
  it('まだ作っていなければ null を返す', async () => {
    expect(await loadChatDeductionRewards(createFakeStore())).toBeNull()
  })

  it('控えた「質問」「解答」の報酬のIDを返す', async () => {
    const store = createFakeStore({ 'chat-deduction-rewards': JSON.stringify({ questionRewardId: '報酬ID-質問', answerRewardId: '報酬ID-解答' }) })

    expect(await loadChatDeductionRewards(store)).toEqual({ questionRewardId: '報酬ID-質問', answerRewardId: '報酬ID-解答' })
  })

  it('控えた中身の形が違えば、作っていないことにせず投げる', async () => {
    const store = createFakeStore({ 'chat-deduction-rewards': JSON.stringify({ questionRewardId: '報酬ID-質問' }) })

    await expect(loadChatDeductionRewards(store)).rejects.toThrowError(/チャットで推理の報酬/)
  })
})
