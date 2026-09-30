/**
 * 選べるモデルの一覧（llm-models.ts）のテスト
 *
 * 管理画面のモデルの選択欄に出す候補を返す。提供元ごとに出どころが違うので、次の点を確かめる。
 * - Workers AI は、このリポジトリが持つ一覧をそのまま返すこと（通信しない）
 * - OpenRouter は公開APIから取り、文章を返さないモデル（画像だけを返すものなど）を除くこと
 * - 取った一覧はKVに1時間貯めて、開くたびに問い合わせないこと
 * - OpenRouter が失敗を返したら、空の一覧にせず投げること（Fail-Fast）
 */
import { describe, expect, it } from 'vitest'
import { createFakeStore } from './fake-store'
import { DEFAULT_LLM_SETTINGS } from './llm-config'
import { WORKERS_AI_MODELS, listLlmModels } from './llm-models'

const now = Date.parse('2026-09-26T12:00:00Z')

/** OpenRouter の公開APIが返す形（このコードが読む項目だけ） */
const openRouterList = {
  data: [
    { id: 'anthropic/claude-3.5-haiku', name: 'Anthropic: Claude 3.5 Haiku', architecture: { output_modalities: ['text'] } },
    { id: 'meta-llama/llama-3.1-8b-instruct', name: 'Meta: Llama 3.1 8B Instruct', architecture: { output_modalities: ['text'] } },
    { id: 'black-forest-labs/flux-1.1-pro', name: 'Black Forest Labs: FLUX 1.1 pro', architecture: { output_modalities: ['image'] } },
  ],
}

/** 呼ばれた回数を控え、決めた応答を返す fetch */
const fakeFetch = (response: () => Response) => {
  const called: string[] = []
  const fetchImpl = (input: RequestInfo | URL): Promise<Response> => {
    called.push(String(input))
    return Promise.resolve(response())
  }
  return { called, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('WORKERS_AI_MODELS', () => {
  it('既定のモデルは候補に含まれている（未保存のままでも画面の選択欄に出る）', () => {
    const ids = WORKERS_AI_MODELS.map(({ id }) => id)

    for (const usage of Object.values(DEFAULT_LLM_SETTINGS.usages)) {
      expect(ids).toContain(usage.models['workers-ai'])
    }
  })

  it('候補はすべて Workers AI のモデル名の形（@cf/ で始まる）である', () => {
    for (const { id, name } of WORKERS_AI_MODELS) {
      expect(id.startsWith('@cf/')).toBe(true)
      expect(name).not.toBe('')
    }
  })
})

describe('listLlmModels（Workers AI）', () => {
  it('このリポジトリが持つ一覧をそのまま返し、通信しない', async () => {
    const { called, fetchImpl } = fakeFetch(() => new Response('呼ばれない', { status: 500 }))

    expect(await listLlmModels('workers-ai', { fetch: fetchImpl, store: createFakeStore(), now })).toEqual(WORKERS_AI_MODELS)
    expect(called).toEqual([])
  })
})

describe('listLlmModels（OpenRouter）', () => {
  it('公開APIから取り、文章を返さないモデルを除いて名前順に並べる', async () => {
    const { called, fetchImpl } = fakeFetch(() => Response.json(openRouterList))

    const models = await listLlmModels('openrouter', { fetch: fetchImpl, store: createFakeStore(), now })

    expect(models).toEqual([
      { id: 'anthropic/claude-3.5-haiku', name: 'Anthropic: Claude 3.5 Haiku' },
      { id: 'meta-llama/llama-3.1-8b-instruct', name: 'Meta: Llama 3.1 8B Instruct' },
    ])
    expect(called).toEqual(['https://openrouter.ai/api/v1/models'])
  })

  it('一度取った一覧はKVに貯めて、1時間のあいだは問い合わせない', async () => {
    const store = createFakeStore()
    const { called, fetchImpl } = fakeFetch(() => Response.json(openRouterList))
    const deps = { fetch: fetchImpl, store, now }

    await listLlmModels('openrouter', deps)
    await listLlmModels('openrouter', deps)
    expect(called).toHaveLength(1)

    // 1時間を過ぎたら取り直す
    await listLlmModels('openrouter', { ...deps, now: now + 61 * 60 * 1000 })
    expect(called).toHaveLength(2)
  })

  it('OpenRouter が失敗を返したら、空の一覧にせず投げる', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('Service Unavailable', { status: 503 }))

    await expect(listLlmModels('openrouter', { fetch: fetchImpl, store: createFakeStore(), now })).rejects.toThrow('503')
  })

  it('応答が想定した形でなければ投げる（空の選択欄を出さない）', async () => {
    const { fetchImpl } = fakeFetch(() => Response.json({ models: [] }))

    await expect(listLlmModels('openrouter', { fetch: fetchImpl, store: createFakeStore(), now })).rejects.toThrow('OpenRouter')
  })

  it('文章を返すモデルが1件も無ければ投げる（選べない選択欄を出さない）', async () => {
    const { fetchImpl } = fakeFetch(() => Response.json({ data: [openRouterList.data[2]] }))

    await expect(listLlmModels('openrouter', { fetch: fetchImpl, store: createFakeStore(), now })).rejects.toThrow('OpenRouter')
  })
})
