/**
 * 観点の提案（opinion-prompt.ts）のテスト
 *
 * LLM を代役に差し替えて、次の点を確かめる。
 * - 材料（テーマ・いまの論点と意見・前の問いかけ）が漏れなく指示に入ること
 * - 箇所 opinionPrompt を指名すること
 * - 返ってきた問いかけが1行で上限の文字数に収まっていれば受け付け、外れたら切り詰めずに拒むこと
 */
import { describe, expect, it } from 'vitest'
import { createFakeAi } from './fake-ai'
import { MAX_PROMPT_LENGTH } from './opinion'
import { OpinionPromptContentError, buildOpinionPromptPrompt, parseOpinionPrompt, proposeOpinionPrompt, type PromptMaterial } from './opinion-prompt'

const material: PromptMaterial = {
  theme: '配信中にAIをどこまで使っていい？',
  board: [
    {
      id: 1,
      title: '視聴者との距離',
      opinions: [
        { id: 10, kind: 'issue', text: 'AIが返事すると、人と話している感じが薄れる' },
        { id: 11, kind: 'insight', text: '初見さんへの挨拶はAIでも嬉しかった' },
      ],
    },
  ],
  previous: 'AIに任せたくない作業はどれ？',
}

describe('buildOpinionPromptPrompt', () => {
  it('テーマ・論点・意見・前の問いかけを入れる', () => {
    const prompt = buildOpinionPromptPrompt(material)

    expect(prompt).toContain('配信中にAIをどこまで使っていい？')
    expect(prompt).toContain('視聴者との距離')
    expect(prompt).toContain('課題: AIが返事すると、人と話している感じが薄れる')
    expect(prompt).toContain('気づき: 初見さんへの挨拶はAIでも嬉しかった')
    expect(prompt).toContain('AIに任せたくない作業はどれ？')
    expect(prompt).toContain(`${MAX_PROMPT_LENGTH}文字以内`)
  })

  it('意見も前の問いかけも無ければ、その旨を書く', () => {
    const prompt = buildOpinionPromptPrompt({ theme: material.theme, board: [], previous: null })

    expect(prompt).toContain('まだありません')
  })
})

describe('parseOpinionPrompt', () => {
  it('前後の空白を除いた1行を問いかけとして受け付ける', () => {
    expect(parseOpinionPrompt('  AIの使用料、配信者はどこまで払っていいと思う？\n')).toBe('AIの使用料、配信者はどこまで払っていいと思う？')
  })

  it('空なら拒む', () => {
    expect(() => parseOpinionPrompt('  \n ')).toThrow(OpinionPromptContentError)
  })

  it('2行以上なら拒む（前置きや候補の列挙を、1つの問いかけとして映さない）', () => {
    expect(() => parseOpinionPrompt('問いかけ案です。\nAIの使用料、配信者はどこまで払っていいと思う？')).toThrow(OpinionPromptContentError)
  })

  it('上限の文字数を超えたら、切り詰めずに拒む', () => {
    const tooLong = 'あ'.repeat(MAX_PROMPT_LENGTH + 1)
    expect(() => parseOpinionPrompt(tooLong)).toThrow(`上限（${MAX_PROMPT_LENGTH}文字）`)
  })

  it('上限ちょうどなら受け付ける', () => {
    const justFits = 'あ'.repeat(MAX_PROMPT_LENGTH)
    expect(parseOpinionPrompt(justFits)).toBe(justFits)
  })
})

describe('proposeOpinionPrompt', () => {
  it('箇所 opinionPrompt を指名して作らせ、照合した問いかけを返す', async () => {
    const llm = createFakeAi({ response: 'AIの使用料、配信者はどこまで払っていいと思う？' })

    expect(await proposeOpinionPrompt(llm, material)).toBe('AIの使用料、配信者はどこまで払っていいと思う？')
    expect(llm.calls.map(({ usage }) => usage)).toEqual(['opinionPrompt'])
  })

  it('LLM が失敗したら、そのまま投げる', async () => {
    await expect(proposeOpinionPrompt(createFakeAi({ shouldFail: true }), material)).rejects.toThrow('無料枠')
  })
})
