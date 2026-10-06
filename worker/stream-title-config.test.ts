/**
 * 配信タイトルの候補づくりの設定（stream-title-config.ts）のテスト
 *
 * 未保存なら作らない（OpenRouter の鍵が無い環境で、失敗を積み上げず、LLMも呼ばないため）こと、
 * 送られてきた設定が true か false でなければ拒むことを確かめる。
 */
import { describe, expect, it } from 'vitest'
import { ConfigError } from './alert-config'
import { createFakeStore } from './fake-store'
import { loadStreamTitleSettings, parseStreamTitleSettings, saveStreamTitleSettings } from './stream-title-config'

describe('parseStreamTitleSettings', () => {
  it('候補を作るかを受け取る', () => {
    expect(parseStreamTitleSettings({ enabled: true })).toEqual({ enabled: true })
  })

  it('true か false でなければ拒む', () => {
    expect(() => parseStreamTitleSettings({ enabled: 'はい' })).toThrow(ConfigError)
    expect(() => parseStreamTitleSettings(null)).toThrow(ConfigError)
  })
})

describe('loadStreamTitleSettings', () => {
  it('未保存なら候補を作らない', async () => {
    expect(await loadStreamTitleSettings(createFakeStore())).toEqual({ enabled: false })
  })

  it('保存した設定を読める', async () => {
    const store = createFakeStore()
    await saveStreamTitleSettings(store, { enabled: true })

    expect(await loadStreamTitleSettings(store)).toEqual({ enabled: true })
  })
})
