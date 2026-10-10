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
import { DEFAULT_LLM_SETTINGS, LLM_USAGES, loadLlmSettings, parseLlmSettings, saveLlmSettings, type LlmSettings, type LlmUsage } from './llm-config'

/** 既定の設定のうち、1か所だけを差し替えたものを作る */
const replaceWith = (usage: LlmUsage, settings: unknown): unknown => ({
  usages: { ...DEFAULT_LLM_SETTINGS.usages, [usage]: settings },
})

/** 配信者が画面で組み立てた設定。あらすじだけ OpenRouter に切り替えている */
const broadcasterConfig: LlmSettings = {
  usages: {
    ...DEFAULT_LLM_SETTINGS.usages,
    streamSummary: {
      provider: 'openrouter',
      models: { 'workers-ai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast', openrouter: 'anthropic/claude-3.5-haiku' },
    },
  },
}

/** 検証で見つかった問題点の一覧を取り出す */
const issues = (input: unknown): readonly string[] => {
  try {
    parseLlmSettings(input)
  } catch (error) {
    return (error as { problems: readonly string[] }).problems
  }
  throw new Error('検証が通ってしまいました')
}

describe('parseLlmSettings', () => {
  it('正しい内容はそのまま保存用の形にする', () => {
    expect(parseLlmSettings(broadcasterConfig)).toEqual(broadcasterConfig)
  })

  it('既定の設定もそのまま通る', () => {
    expect(parseLlmSettings(DEFAULT_LLM_SETTINGS)).toEqual(DEFAULT_LLM_SETTINGS)
  })

  it('オブジェクトでなければ拒否する', () => {
    expect(issues('openrouter')).toEqual([expect.stringContaining('オブジェクト')])
  })

  it('使う箇所が1つでも欠けていれば拒否する（黙って既定で埋めない）', () => {
    const rest = { ...DEFAULT_LLM_SETTINGS.usages, streamSummary: undefined }

    expect(issues({ usages: rest })).toEqual([expect.stringContaining('streamSummary')])
  })

  it('知らない提供元は拒否する（黙って Workers AI に倒さない）', () => {
    expect(issues(replaceWith('aiChat', { ...DEFAULT_LLM_SETTINGS.usages.aiChat, provider: 'openai' }))).toEqual([
      expect.stringContaining('aiChat.provider'),
    ])
  })

  it('空のモデル名は拒否する', () => {
    expect(
      issues(replaceWith('sideSuper', { provider: 'workers-ai', models: { 'workers-ai': '', openrouter: 'meta-llama/llama-3.1-8b-instruct' } })),
    ).toEqual([expect.stringContaining('sideSuper.models.workers-ai')])
  })

  it('Workers AI の候補に無いモデル名は拒否する（画面は選択式なので、打ち間違いはここで止める）', () => {
    expect(
      issues(replaceWith('aiChat', { provider: 'workers-ai', models: { 'workers-ai': '@cf/meta/存在しないモデル', openrouter: 'meta-llama/llama-3.1-8b-instruct' } })),
    ).toEqual([expect.stringContaining('aiChat.models.workers-ai')])
  })

  it('OpenRouter のモデル名は候補表と照らし合わせない（一覧は遠隔で変わり、保存のたびに問い合わせないため）', () => {
    expect(
      parseLlmSettings(
        replaceWith('aiChat', {
          provider: 'openrouter',
          models: { 'workers-ai': '@cf/meta/llama-3.1-8b-instruct-fp8', openrouter: 'まだ知らない提供者/新しいモデル' },
        }),
      ).usages.aiChat.models.openrouter,
    ).toBe('まだ知らない提供者/新しいモデル')
  })

  it('モデル名の前後の空白は落としてから保存する', () => {
    const config = parseLlmSettings(
      replaceWith('viewerSummary', {
        provider: 'openrouter',
        models: { 'workers-ai': '  @cf/meta/llama-3.1-8b-instruct-fp8  ', openrouter: '  openai/gpt-4o-mini  ' },
      }),
    )

    expect(config.usages.viewerSummary.models).toEqual({ 'workers-ai': '@cf/meta/llama-3.1-8b-instruct-fp8', openrouter: 'openai/gpt-4o-mini' })
  })

  it('使っていない提供元のモデル名も検証する（切り替えたときに初めて拒まれることがないようにする）', () => {
    expect(issues(replaceWith('aiChat', { provider: 'workers-ai', models: { 'workers-ai': '@cf/meta/llama-3.1-8b-instruct-fp8', openrouter: '' } }))).toEqual(
      [expect.stringContaining('aiChat.models.openrouter')],
    )
  })

  it('問題点は最初の1件で止めず、すべて集めてから拒否する', () => {
    expect(issues({ usages: { aiChat: { provider: 'openai', models: { 'workers-ai': 1, openrouter: '' } } } })).toHaveLength(13)
  })

  it('使う箇所は11つで、市町村紹介の共通点のほかは既定の提供元が Workers AI である', () => {
    expect(LLM_USAGES).toEqual([
      'translation',
      'aiChat',
      'sideSuper',
      'viewerSummary',
      'streamSummary',
      'streamTitle',
      'townTour',
      'townBond',
      'autoText',
      'opinionSort',
      'opinionPrompt',
    ])
    for (const usage of LLM_USAGES.filter((candidate) => candidate !== 'townBond')) expect(DEFAULT_LLM_SETTINGS.usages[usage].provider).toBe('workers-ai')
  })

  it('テキストの自動の書き換えは、5分おきの収集でテキストごとに呼ぶので、サイドスーパーと同じ軽いモデルを既定にする', () => {
    expect(DEFAULT_LLM_SETTINGS.usages.autoText.models).toEqual(DEFAULT_LLM_SETTINGS.usages.sideSuper.models)
  })

  it('意見ボードの振り分けは、JSON の形とラベルを守らせるので、あらすじと同じ大きいモデルを既定にする', () => {
    expect(DEFAULT_LLM_SETTINGS.usages.opinionSort.models).toEqual(DEFAULT_LLM_SETTINGS.usages.streamSummary.models)
  })

  it('意見ボードの問いかけは、まだ出ていない切り口を自然な日本語の1文で作らせるので、あらすじと同じ大きいモデルを既定にする', () => {
    expect(DEFAULT_LLM_SETTINGS.usages.opinionPrompt.models).toEqual(DEFAULT_LLM_SETTINGS.usages.streamSummary.models)
  })

  it('市町村紹介の共通点は、試作でいちばん良かった OpenRouter の google/gemini-3.8-flash を既定にする', () => {
    // Workers AI の llama-3.3-70b は例文の中身を写して町の事実を作ったので、既定にしない（issue #275）
    expect(DEFAULT_LLM_SETTINGS.usages.townBond.provider).toBe('openrouter')
    expect(DEFAULT_LLM_SETTINGS.usages.townBond.models.openrouter).toBe('google/gemini-3.8-flash')
  })

  it('既定では、あらすじだけ大きいモデルを使う（ほかの3か所とモデル名が違う）', () => {
    const { aiChat, sideSuper, viewerSummary, streamSummary } = DEFAULT_LLM_SETTINGS.usages

    expect(sideSuper.models).toEqual(aiChat.models)
    expect(viewerSummary.models).toEqual(aiChat.models)
    expect(streamSummary.models['workers-ai']).not.toBe(aiChat.models['workers-ai'])
  })

  it('字幕の翻訳は、発話ごとに呼ばれるので軽いモデルを既定にする', () => {
    expect(DEFAULT_LLM_SETTINGS.usages.translation.models).toEqual(DEFAULT_LLM_SETTINGS.usages.aiChat.models)
  })

  it('市町村紹介は、レイドのときだけ呼ばれ材料にない内容を書かせたくないので、あらすじと同じ大きいモデルを既定にする', () => {
    expect(DEFAULT_LLM_SETTINGS.usages.townTour.models).toEqual(DEFAULT_LLM_SETTINGS.usages.streamSummary.models)
  })

  it('配信タイトルの候補は、8bでは日本語の言い回しが弱いと見込むので、あらすじと同じ大きいモデルを既定にする', () => {
    expect(DEFAULT_LLM_SETTINGS.usages.streamTitle.models).toEqual(DEFAULT_LLM_SETTINGS.usages.streamSummary.models)
  })
})

describe('loadLlmSettings', () => {
  it('未保存なら既定の設定を返す', async () => {
    expect(await loadLlmSettings(createFakeStore())).toEqual(DEFAULT_LLM_SETTINGS)
  })

  it('保存した設定をそのまま読み出せる', async () => {
    const store = createFakeStore()
    await saveLlmSettings(store, broadcasterConfig)
    expect(await loadLlmSettings(store)).toEqual(broadcasterConfig)
  })

  it('保存されている形が古ければ、読み替えずにエラーにする（直し方を文面に出す）', async () => {
    // 用途を chat・summary の2つにまとめていたころの形
    const store = createFakeStore({
      'llm-settings': JSON.stringify({ provider: 'workers-ai', workersAi: { chat: 'a', summary: 'b' }, openrouter: { chat: 'c', summary: 'd' } }),
    })

    await expect(loadLlmSettings(store)).rejects.toThrow('llm-settings')
  })

  it('箇所を足す前に保存された設定は、足した箇所だけ既定で補って読み出す（ほかの箇所の選択は残す）', async () => {
    // 前提: 字幕の翻訳（translation）を足す前に保存された設定には、そのキーが無い
    const savedBeforeTranslation = Object.fromEntries(Object.entries(broadcasterConfig.usages).filter(([usage]) => usage !== 'translation'))
    const store = createFakeStore({ 'llm-settings': JSON.stringify({ usages: savedBeforeTranslation }) })

    expect(await loadLlmSettings(store)).toEqual({ usages: { ...broadcasterConfig.usages, translation: DEFAULT_LLM_SETTINGS.usages.translation } })
  })

  it('保存されている箇所の中身が壊れていれば、補わずにエラーにする', async () => {
    const store = createFakeStore({ 'llm-settings': JSON.stringify({ usages: { ...broadcasterConfig.usages, aiChat: { provider: 'openai' } } }) })

    await expect(loadLlmSettings(store)).rejects.toThrow('llm-settings')
  })
})
