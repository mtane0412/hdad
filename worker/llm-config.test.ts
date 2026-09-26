/**
 * LLMの設定（llm-config.ts）のテスト
 *
 * どの提供元（Workers AI・OpenRouter）のどのモデルに文面を作らせるかを、管理画面から受け取って検証する。
 * 特に重要なのは次の3点。
 * - 提供元ごとにモデル名を別に持つこと（提供元を切り替えて戻したときに、前のモデル名が消えないため）
 * - 問題点を最初の1件で止めず、すべて集めてから拒否すること（管理画面で一度に直せるようにするため）
 * - 未保存なら既定の設定（Workers AI）で動くこと（設定していない配信者のあらすじづくりを止めないため）
 */
import { describe, expect, it } from 'vitest'
import { createFakeStore } from './fake-store'
import { DEFAULT_LLM_SETTINGS, loadLlmSettings, parseLlmSettings, saveLlmSettings, type LlmSettings } from './llm-config'

/** 配信者が画面で組み立てた、OpenRouter を使う設定 */
const 配信者の設定: LlmSettings = {
  provider: 'openrouter',
  workersAi: { chat: '@cf/meta/llama-3.1-8b-instruct-fp8', summary: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
  openrouter: { chat: 'meta-llama/llama-3.1-8b-instruct', summary: 'anthropic/claude-3.5-haiku' },
}

/** 既定の設定に、変えたい項目だけを上書きしたものを送る */
const 送る = (上書き: Record<string, unknown> = {}): unknown => ({ ...DEFAULT_LLM_SETTINGS, ...上書き })

/** 検証で見つかった問題点の一覧を取り出す */
const 問題点 = (input: unknown): readonly string[] => {
  try {
    parseLlmSettings(input)
  } catch (error) {
    return (error as { problems: readonly string[] }).problems
  }
  throw new Error('検証が通ってしまいました')
}

describe('parseLlmSettings', () => {
  it('正しい内容はそのまま保存用の形にする', () => {
    expect(parseLlmSettings(配信者の設定)).toEqual(配信者の設定)
  })

  it('既定の設定もそのまま通る', () => {
    expect(parseLlmSettings(送る())).toEqual(DEFAULT_LLM_SETTINGS)
  })

  it('オブジェクトでなければ拒否する', () => {
    expect(問題点('openrouter')).toEqual([expect.stringContaining('オブジェクト')])
  })

  it('知らない提供元は拒否する（黙って Workers AI に倒さない）', () => {
    expect(問題点(送る({ provider: 'openai' }))).toEqual([expect.stringContaining('provider')])
  })

  it('提供元ごとのモデル名が無ければ拒否する', () => {
    expect(問題点(送る({ openrouter: undefined }))).toEqual([expect.stringContaining('openrouter')])
  })

  it('空のモデル名は拒否する', () => {
    expect(問題点(送る({ workersAi: { chat: '', summary: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' } }))).toEqual([
      expect.stringContaining('workersAi.chat'),
    ])
  })

  it('モデル名の前後の空白は落としてから保存する', () => {
    expect(parseLlmSettings(送る({ openrouter: { chat: '  meta-llama/llama-3.1-8b-instruct  ', summary: 'openai/gpt-4o-mini' } })).openrouter).toEqual({
      chat: 'meta-llama/llama-3.1-8b-instruct',
      summary: 'openai/gpt-4o-mini',
    })
  })

  it('問題点は最初の1件で止めず、すべて集めてから拒否する', () => {
    expect(問題点({ provider: 'openai', workersAi: { chat: 1, summary: '' }, openrouter: null })).toHaveLength(4)
  })

  it('使っていない提供元のモデル名も検証する（切り替えたときに初めて拒まれることがないようにする）', () => {
    expect(問題点(送る({ provider: 'workers-ai', openrouter: { chat: '', summary: '' } }))).toEqual([
      expect.stringContaining('openrouter.chat'),
      expect.stringContaining('openrouter.summary'),
    ])
  })
})

describe('loadLlmSettings', () => {
  it('未保存なら既定の設定（Workers AI）を返す', async () => {
    expect(await loadLlmSettings(createFakeStore())).toEqual(DEFAULT_LLM_SETTINGS)
    expect(DEFAULT_LLM_SETTINGS.provider).toBe('workers-ai')
  })

  it('保存した設定をそのまま読み出せる', async () => {
    const store = createFakeStore()
    await saveLlmSettings(store, 配信者の設定)
    expect(await loadLlmSettings(store)).toEqual(配信者の設定)
  })
})
