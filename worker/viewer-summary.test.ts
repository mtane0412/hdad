/**
 * LLMによる人物像づくり（viewer-summary.ts）のテスト
 *
 * 材料（その配信での発言・これまでの記録・配信者が書いたメモ・前回までの人物像）が漏れなくLLMへ渡ること、
 * 返ってきた人物像をそのまま信用せず、貯められる長さに収まっているかを確かめてから返すことを確認する。
 */
import { describe, expect, it } from 'vitest'
import type { TextGenerator } from './ai-chat'
import { MAX_VIEWER_SUMMARY_LENGTH, buildSummaryPrompt, generateViewerSummary } from './viewer-summary'
import type { Viewer } from './viewer-store'

const 記録: Viewer = {
  userId: '100',
  login: 'hanako',
  displayName: '花子',
  firstSeenAt: '2026-06-01T12:00:00.000Z',
  lastSeenAt: '2026-09-21T12:00:00.000Z',
  messageCount: 42,
  badges: ['subscriber'],
  note: 'ギターの話が好き',
  summary: '',
  summarizedAt: null,
}

const 材料 = (上書き: Partial<Parameters<typeof buildSummaryPrompt>[0]> = {}) => ({
  viewer: 記録,
  messages: ['こんばんは', 'そのギターいいですね'],
  ...上書き,
})

/** 決まった文面を返すLLMの代役。渡された引数を控えて、材料が漏れていないかを確かめられるようにする */
const 代役 = (response: unknown): TextGenerator & { 呼ばれた: { model: string; input: Record<string, unknown> }[] } => {
  const 呼ばれた: { model: string; input: Record<string, unknown> }[] = []
  return {
    呼ばれた,
    run: (model, input) => {
      呼ばれた.push({ model, input })
      return Promise.resolve(response)
    },
  }
}

describe('buildSummaryPrompt', () => {
  it('その配信での発言と、これまでの記録と、配信者が書いたメモを材料に入れる', () => {
    const prompt = buildSummaryPrompt(材料())

    expect(prompt).toContain('こんばんは')
    expect(prompt).toContain('そのギターいいですね')
    expect(prompt).toContain('花子')
    expect(prompt).toContain('42')
    expect(prompt).toContain('ギターの話が好き')
  })

  it('前回までの人物像があれば、それを踏まえて書き直させる', () => {
    const prompt = buildSummaryPrompt(材料({ viewer: { ...記録, summary: '音楽に詳しい常連さん' } }))

    expect(prompt).toContain('音楽に詳しい常連さん')
  })

  it('人物像の長さの上限を指示に書く', () => {
    expect(buildSummaryPrompt(材料())).toContain(String(MAX_VIEWER_SUMMARY_LENGTH))
  })
})

describe('generateViewerSummary', () => {
  it('LLMが返した人物像を、改行を空白に直して返す', async () => {
    const ai = 代役({ response: 'ギターの話をよくする常連さん。\n配信の最初から来ることが多い。' })

    expect(await generateViewerSummary(ai, 材料())).toBe('ギターの話をよくする常連さん。 配信の最初から来ることが多い。')
  })

  it('LLMが失敗したら、そのまま投げる（黙って空の人物像にしない）', async () => {
    const ai: TextGenerator = { run: () => Promise.reject(new Error('無料枠を使い切りました')) }

    await expect(generateViewerSummary(ai, 材料())).rejects.toThrow('無料枠を使い切りました')
  })

  it('応答の形が違えば投げる', async () => {
    await expect(generateViewerSummary(代役({ result: 'ちがう形' }), 材料())).rejects.toThrow('LLMの応答を読めません')
  })

  it('空の人物像なら投げる（中身のない推測を貯めない）', async () => {
    await expect(generateViewerSummary(代役({ response: '   ' }), 材料())).rejects.toThrow('空の人物像')
  })

  it('上限より長い人物像なら、切り詰めずに投げる', async () => {
    const ai = 代役({ response: 'あ'.repeat(MAX_VIEWER_SUMMARY_LENGTH + 1) })

    await expect(generateViewerSummary(ai, 材料())).rejects.toThrow(`${MAX_VIEWER_SUMMARY_LENGTH + 1}文字`)
  })
})
