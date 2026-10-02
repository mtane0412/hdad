/**
 * 字幕の翻訳の設定（translation-config.ts）のテスト
 *
 * 確定した発話をどの提供元で訳すか（訳さない・LLM・Workers AI の翻訳専用モデル・DeepL）を、管理画面（/llm/）から
 * 受け取って検証する。確かめるのは次の3点である。
 * - 未保存なら訳さない（提供元を選ぶまで、料金も無料枠も使わない）
 * - 知らない提供元は黙って既定に倒さず拒む（Fail-Fast）
 * - 保存した設定をそのまま読み出せる
 */
import { describe, expect, it } from 'vitest'
import { ConfigError } from './alert-config'
import { createFakeStore } from './fake-store'
import { DEFAULT_TRANSLATION_SETTINGS, loadTranslationSettings, parseTranslationSettings, saveTranslationSettings } from './translation-config'

describe('parseTranslationSettings', () => {
  it('選べる提供元はそのまま保存用の形にする', () => {
    for (const provider of ['off', 'llm', 'm2m100', 'deepl']) {
      expect(parseTranslationSettings({ provider })).toEqual({ provider })
    }
  })

  it('知らない提供元は拒否する（黙って「訳さない」に倒さない）', () => {
    expect(() => parseTranslationSettings({ provider: 'google' })).toThrow(ConfigError)
  })

  it('オブジェクトでなければ拒否する', () => {
    expect(() => parseTranslationSettings('deepl')).toThrow(ConfigError)
  })

  it('未保存のときは訳さない', () => {
    expect(DEFAULT_TRANSLATION_SETTINGS).toEqual({ provider: 'off' })
  })
})

describe('loadTranslationSettings', () => {
  it('未保存なら既定の設定を返す', async () => {
    expect(await loadTranslationSettings(createFakeStore())).toEqual(DEFAULT_TRANSLATION_SETTINGS)
  })

  it('保存した設定をそのまま読み出せる', async () => {
    const store = createFakeStore()
    await saveTranslationSettings(store, { provider: 'deepl' })

    expect(await loadTranslationSettings(store)).toEqual({ provider: 'deepl' })
  })

  it('保存されている形が読めなければ、エラーにする（直し方を文面に出す）', async () => {
    const store = createFakeStore({ 'translation-settings': JSON.stringify({ provider: 'google' }) })

    await expect(loadTranslationSettings(store)).rejects.toThrow('translation-settings')
  })
})
