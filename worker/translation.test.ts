/**
 * 字幕の翻訳（translation.ts）のテスト
 *
 * 確定した発話1件を、設定（translation-settings）で選んだ提供元で英語に訳す。確かめるのは次の点である。
 * - 「訳さない」なら、どの提供元も呼ばずに null を返す
 * - LLM なら、箇所 translation を指名し、直前の発話を文脈として渡す
 * - Workers AI の翻訳専用モデル（m2m100）なら、日本語から英語への訳を頼み、使用状況を llm_usage へ足し込む
 * - DeepL なら、直前の発話を課金されない context で渡し、使用状況を llm_usage へ足し込む
 * - 失敗は黙って別の提供元へ落とさずに投げる（使用状況には失敗として数える）
 */
import { describe, expect, it } from 'vitest'
import { createFakeAi, createFakeWorkersAi } from './fake-ai'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'
import { listLlmUsage } from './llm-usage-store'
import type { WorkersAi } from './llm'
import { saveTranslationSettings, type TranslationProvider } from './translation-config'
import { createTranslator, readDeeplUsage, type TranslatorOptions } from './translation'

const now = Date.parse('2026-10-02T12:00:00Z')

/** 配信者の直前の発話と、いま確定した発話 */
const spoken = { text: 'じゃあ次のステージ行きましょう', context: ['ボス倒せた', 'やったー'] }

const noFetch = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

/** m2m100 の応答を返す Workers AI の代役 */
const translatingWorkersAi = (translatedText: unknown): WorkersAi & { calls: { model: string; input: Record<string, unknown> }[] } => {
  const calls: { model: string; input: Record<string, unknown> }[] = []
  return {
    calls,
    run: (model, input) => {
      calls.push({ model, input })
      return Promise.resolve({ translated_text: translatedText })
    },
  }
}

/** 提供元を選んだ状態で翻訳を組み立てる */
const setup = async (provider: TranslationProvider, overrides: Partial<TranslatorOptions> = {}) => {
  const store = createFakeStore()
  await saveTranslationSettings(store, { provider })
  const db = createFakeDatabase()
  const options: TranslatorOptions = {
    store,
    llm: createFakeAi({ response: "OK, let's go to the next stage" }),
    ai: createFakeWorkersAi(),
    fetch: noFetch,
    deeplApiKey: undefined,
    db,
    now: () => now,
    ...overrides,
  }
  return { translator: createTranslator(options), db, options }
}

describe('createTranslator', () => {
  it('「訳さない」なら、どの提供元も呼ばずに null を返す', async () => {
    const llm = createFakeAi()
    const ai = createFakeWorkersAi()
    const { translator } = await setup('off', { llm, ai })

    expect(await translator.translate(spoken)).toBeNull()
    expect(llm.calls).toHaveLength(0)
    expect(ai.calls).toHaveLength(0)
  })

  describe('LLM', () => {
    it('箇所 translation を指名し、直前の発話を文脈として渡して、訳文を返す', async () => {
      const llm = createFakeAi({ response: "  OK, let's go to the next stage\n" })
      const { translator } = await setup('llm', { llm })

      expect(await translator.translate(spoken)).toBe("OK, let's go to the next stage")
      expect(llm.calls).toHaveLength(1)
      expect(llm.calls[0]?.usage).toBe('translation')
      const prompt = llm.calls[0]?.request.messages.map(({ content }) => content).join('\n') ?? ''
      expect(prompt).toContain('ボス倒せた')
      expect(prompt).toContain('やったー')
      expect(prompt).toContain('じゃあ次のステージ行きましょう')
    })

    it('LLM が失敗したら、黙って別の提供元へ落とさずに投げる', async () => {
      const ai = translatingWorkersAi('fallback')
      const { translator } = await setup('llm', { llm: createFakeAi({ shouldFail: true }), ai })

      await expect(translator.translate(spoken)).rejects.toThrow('LLMの無料枠を使い切りました')
      expect(ai.calls).toHaveLength(0)
    })

    it('LLM が空の文面を返したら、訳せなかったものとして投げる', async () => {
      const { translator } = await setup('llm', { llm: createFakeAi({ response: '   ' }) })

      await expect(translator.translate(spoken)).rejects.toThrow('訳文')
    })
  })

  describe('Workers AI の翻訳専用モデル（m2m100）', () => {
    it('日本語から英語への訳を頼み、訳文を返す', async () => {
      const ai = translatingWorkersAi("Let's go to the next stage")
      const { translator } = await setup('m2m100', { ai })

      expect(await translator.translate(spoken)).toBe("Let's go to the next stage")
      expect(ai.calls).toEqual([{ model: '@cf/meta/m2m100-1.2b', input: { text: spoken.text, source_lang: 'ja', target_lang: 'en' } }])
    })

    it('呼んだことを使用状況（箇所 translation）へ足し込む', async () => {
      const { translator, db } = await setup('m2m100', { ai: translatingWorkersAi("Let's go") })

      await translator.translate(spoken)

      expect(await listLlmUsage(db, '2026-10-02')).toEqual([
        expect.objectContaining({ usage: 'translation', provider: 'workers-ai', model: '@cf/meta/m2m100-1.2b', calls: 1, failures: 0 }),
      ])
    })

    it('訳文が入っていない応答は、投げたうえで失敗として数える', async () => {
      const { translator, db } = await setup('m2m100', { ai: translatingWorkersAi(undefined) })

      await expect(translator.translate(spoken)).rejects.toThrow('m2m100')
      expect(await listLlmUsage(db, '2026-10-02')).toEqual([expect.objectContaining({ usage: 'translation', calls: 0, failures: 1 })])
    })
  })

  describe('DeepL', () => {
    it('鍵が無ければ、呼ばずに投げる', async () => {
      const { translator } = await setup('deepl')

      await expect(translator.translate(spoken)).rejects.toThrow('DEEPL_API_KEY')
    })

    it('直前の発話を課金されない context で渡し、日本語から英語へ訳した文を返す', async () => {
      const requests: Request[] = []
      const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        requests.push(new Request(input, init))
        return Response.json({ translations: [{ detected_source_language: 'JA', text: "Let's head to the next stage" }] })
      }
      const { translator } = await setup('deepl', { fetch: fetchImpl, deeplApiKey: 'deepl-test-key:fx' })

      expect(await translator.translate(spoken)).toBe("Let's head to the next stage")
      const [request] = requests
      expect(request?.url).toBe('https://api-free.deepl.com/v2/translate')
      expect(request?.headers.get('Authorization')).toBe('DeepL-Auth-Key deepl-test-key:fx')
      expect(await request?.json()).toEqual({ text: [spoken.text], source_lang: 'JA', target_lang: 'EN-US', context: 'ボス倒せた\nやったー' })
    })

    it('DeepL が失敗を返したら、状態と本文を添えて投げ、失敗として数える', async () => {
      const fetchImpl = async (): Promise<Response> => new Response('Quota exceeded', { status: 456 })
      const { translator, db } = await setup('deepl', { fetch: fetchImpl, deeplApiKey: 'deepl-test-key:fx' })

      await expect(translator.translate(spoken)).rejects.toThrow('456')
      expect(await listLlmUsage(db, '2026-10-02')).toEqual([
        expect.objectContaining({ usage: 'translation', provider: 'deepl', model: 'deepl-free', calls: 0, failures: 1 }),
      ])
    })
  })
})

describe('readDeeplUsage', () => {
  it('今月訳した文字数と上限を読む', async () => {
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      expect(request.url).toBe('https://api-free.deepl.com/v2/usage')
      expect(request.headers.get('Authorization')).toBe('DeepL-Auth-Key deepl-test-key:fx')
      return Response.json({ character_count: 180118, character_limit: 500000 })
    }

    expect(await readDeeplUsage({ fetch: fetchImpl, apiKey: 'deepl-test-key:fx' })).toEqual({ characterCount: 180118, characterLimit: 500000 })
  })

  it('想定した形でなければ投げる（0 として見せない）', async () => {
    const fetchImpl = async (): Promise<Response> => Response.json({ character_count: '180118' })

    await expect(readDeeplUsage({ fetch: fetchImpl, apiKey: 'deepl-test-key:fx' })).rejects.toThrow('DeepL')
  })
})
