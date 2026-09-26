/**
 * LLMの設定（llm-config.ts）のテスト
 *
 * AIを使う4か所（トリガーの動作 aiChat・サイドスーパー・視聴者の人物像・配信のあらすじ）それぞれについて、
 * どの提供元（Workers AI・OpenRouter）のどのモデルに作らせるかを、管理画面から受け取って検証する。
 * 特に重要なのは次の4点。
 * - 使う箇所ごとに提供元を選べること（あらすじだけ OpenRouter にする、といった使い方ができる）
 * - 提供元ごとにモデル名を別に持つこと（提供元を切り替えて戻したときに、前のモデル名が消えないため）
 * - 問題点を最初の1件で止めず、すべて集めてから拒否すること（管理画面で一度に直せるようにするため）
 * - 未保存なら既定の設定（すべて Workers AI）で動くこと（設定していない配信者のあらすじづくりを止めないため）
 */
import { describe, expect, it } from 'vitest'
import { createFakeStore } from './fake-store'
import { DEFAULT_LLM_SETTINGS, LLM_USAGES, loadLlmSettings, parseLlmSettings, saveLlmSettings, type LlmSettings } from './llm-config'

/** 既定の設定のうち、1か所だけを差し替えたものを作る */
const 差し替える = (usage: 'aiChat' | 'sideSuper' | 'viewerSummary' | 'streamSummary', settings: unknown): unknown => ({
  usages: { ...DEFAULT_LLM_SETTINGS.usages, [usage]: settings },
})

/** 配信者が画面で組み立てた設定。あらすじだけ OpenRouter に切り替えている */
const 配信者の設定: LlmSettings = {
  usages: {
    ...DEFAULT_LLM_SETTINGS.usages,
    streamSummary: {
      provider: 'openrouter',
      models: { 'workers-ai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast', openrouter: 'anthropic/claude-3.5-haiku' },
    },
  },
}

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
    expect(parseLlmSettings(DEFAULT_LLM_SETTINGS)).toEqual(DEFAULT_LLM_SETTINGS)
  })

  it('オブジェクトでなければ拒否する', () => {
    expect(問題点('openrouter')).toEqual([expect.stringContaining('オブジェクト')])
  })

  it('使う箇所が1つでも欠けていれば拒否する（黙って既定で埋めない）', () => {
    const 残り = { ...DEFAULT_LLM_SETTINGS.usages, streamSummary: undefined }

    expect(問題点({ usages: 残り })).toEqual([expect.stringContaining('streamSummary')])
  })

  it('知らない提供元は拒否する（黙って Workers AI に倒さない）', () => {
    expect(問題点(差し替える('aiChat', { ...DEFAULT_LLM_SETTINGS.usages.aiChat, provider: 'openai' }))).toEqual([
      expect.stringContaining('aiChat.provider'),
    ])
  })

  it('空のモデル名は拒否する', () => {
    expect(
      問題点(差し替える('sideSuper', { provider: 'workers-ai', models: { 'workers-ai': '', openrouter: 'meta-llama/llama-3.1-8b-instruct' } })),
    ).toEqual([expect.stringContaining('sideSuper.models.workers-ai')])
  })

  it('Workers AI の候補に無いモデル名は拒否する（画面は選択式なので、打ち間違いはここで止める）', () => {
    expect(
      問題点(差し替える('aiChat', { provider: 'workers-ai', models: { 'workers-ai': '@cf/meta/存在しないモデル', openrouter: 'meta-llama/llama-3.1-8b-instruct' } })),
    ).toEqual([expect.stringContaining('aiChat.models.workers-ai')])
  })

  it('OpenRouter のモデル名は候補表と照らし合わせない（一覧は遠隔で変わり、保存のたびに問い合わせないため）', () => {
    expect(
      parseLlmSettings(
        差し替える('aiChat', {
          provider: 'openrouter',
          models: { 'workers-ai': '@cf/meta/llama-3.1-8b-instruct-fp8', openrouter: 'まだ知らない提供者/新しいモデル' },
        }),
      ).usages.aiChat.models.openrouter,
    ).toBe('まだ知らない提供者/新しいモデル')
  })

  it('モデル名の前後の空白は落としてから保存する', () => {
    const 設定 = parseLlmSettings(
      差し替える('viewerSummary', {
        provider: 'openrouter',
        models: { 'workers-ai': '  @cf/meta/llama-3.1-8b-instruct-fp8  ', openrouter: '  openai/gpt-4o-mini  ' },
      }),
    )

    expect(設定.usages.viewerSummary.models).toEqual({ 'workers-ai': '@cf/meta/llama-3.1-8b-instruct-fp8', openrouter: 'openai/gpt-4o-mini' })
  })

  it('使っていない提供元のモデル名も検証する（切り替えたときに初めて拒まれることがないようにする）', () => {
    expect(問題点(差し替える('aiChat', { provider: 'workers-ai', models: { 'workers-ai': '@cf/meta/llama-3.1-8b-instruct-fp8', openrouter: '' } }))).toEqual(
      [expect.stringContaining('aiChat.models.openrouter')],
    )
  })

  it('問題点は最初の1件で止めず、すべて集めてから拒否する', () => {
    expect(問題点({ usages: { aiChat: { provider: 'openai', models: { 'workers-ai': 1, openrouter: '' } } } })).toHaveLength(6)
  })

  it('使う箇所は4つで、それぞれ既定の提供元は Workers AI である', () => {
    expect(LLM_USAGES).toEqual(['aiChat', 'sideSuper', 'viewerSummary', 'streamSummary'])
    for (const usage of LLM_USAGES) expect(DEFAULT_LLM_SETTINGS.usages[usage].provider).toBe('workers-ai')
  })

  it('既定では、あらすじだけ大きいモデルを使う（ほかの3か所とモデル名が違う）', () => {
    const { aiChat, sideSuper, viewerSummary, streamSummary } = DEFAULT_LLM_SETTINGS.usages

    expect(sideSuper.models).toEqual(aiChat.models)
    expect(viewerSummary.models).toEqual(aiChat.models)
    expect(streamSummary.models['workers-ai']).not.toBe(aiChat.models['workers-ai'])
  })
})

describe('loadLlmSettings', () => {
  it('未保存なら既定の設定を返す', async () => {
    expect(await loadLlmSettings(createFakeStore())).toEqual(DEFAULT_LLM_SETTINGS)
  })

  it('保存した設定をそのまま読み出せる', async () => {
    const store = createFakeStore()
    await saveLlmSettings(store, 配信者の設定)
    expect(await loadLlmSettings(store)).toEqual(配信者の設定)
  })

  it('保存されている形が古ければ、読み替えずにエラーにする（直し方を文面に出す）', async () => {
    // 用途を chat・summary の2つにまとめていたころの形
    const store = createFakeStore({
      'llm-settings': JSON.stringify({ provider: 'workers-ai', workersAi: { chat: 'a', summary: 'b' }, openrouter: { chat: 'c', summary: 'd' } }),
    })

    await expect(loadLlmSettings(store)).rejects.toThrow('llm-settings')
  })
})
