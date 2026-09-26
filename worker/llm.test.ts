/**
 * LLMの呼び出し（llm.ts）のテスト
 *
 * 呼び出し側は用途（chat・summary）だけを指名し、どの提供元のどのモデルを使うかは保存された設定
 * （llm-config.ts）が決める。ここで確かめるのは次の点である。
 * - 用途ごとに、その提供元のモデル名が渡ること
 * - Workers AI と OpenRouter のどちらの応答からも文面を読めること
 * - OpenRouter を選んでいるのに鍵が無い・OpenRouter が失敗を返した場合に、黙って Workers AI へ落とさず投げること
 * - 設定の読み出し（KV）が1回で済むこと（発言のたびに呼ばれる道に、余分な読み出しを増やさないため）
 */
import { describe, expect, it } from 'vitest'
import { createFakeStore } from './fake-store'
import { DEFAULT_LLM_SETTINGS, saveLlmSettings, type LlmSettings } from './llm-config'
import { createLlm, readResponse, type WorkersAi } from './llm'

/** 送る材料。中身はこのテストでは問わない */
const 材料 = { messages: [{ role: 'user' as const, content: 'こんばんは！' }], maxTokens: 300 }

/** Workers AI のバインディングの代役。渡された引数を控える */
const バインディングの代役 = (result: unknown = { response: 'こんばんは！' }): WorkersAi & { 呼ばれた: { model: string; input: Record<string, unknown> }[] } => {
  const 呼ばれた: { model: string; input: Record<string, unknown> }[] = []
  return { 呼ばれた, run: (model, input) => (呼ばれた.push({ model, input }), Promise.resolve(result)) }
}

/** OpenRouter の応答の代役。渡されたリクエストを控える */
const 通信の代役 = (応答: Response): typeof fetch & { 呼ばれた: Request[] } => {
  const 呼ばれた: Request[] = []
  const impl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    呼ばれた.push(new Request(input as RequestInfo, init))
    return Promise.resolve(応答)
  }
  return Object.assign(impl as typeof fetch, { 呼ばれた })
}

const OpenRouterの応答 = (content: string): Response => Response.json({ choices: [{ message: { role: 'assistant', content } }] })

/** 提供元を OpenRouter にした設定 */
const OpenRouterの設定: LlmSettings = {
  ...DEFAULT_LLM_SETTINGS,
  provider: 'openrouter',
  openrouter: { chat: 'meta-llama/llama-3.1-8b-instruct', summary: 'anthropic/claude-3.5-haiku' },
}

describe('createLlm（Workers AI）', () => {
  it('未保存なら Workers AI のバインディングを、用途ごとのモデル名で呼ぶ', async () => {
    const ai = バインディングの代役()
    const llm = createLlm({ ai, store: createFakeStore(), fetch: 通信の代役(OpenRouterの応答('使われない')), apiKey: undefined })

    expect(await llm.run('chat', 材料)).toBe('こんばんは！')
    expect(ai.呼ばれた).toEqual([
      { model: DEFAULT_LLM_SETTINGS.workersAi.chat, input: { messages: 材料.messages, max_tokens: 300 } },
    ])
  })

  it('あらすじ（summary）では、あらすじ用のモデルを使う', async () => {
    const ai = バインディングの代役()
    const llm = createLlm({ ai, store: createFakeStore(), fetch: 通信の代役(OpenRouterの応答('使われない')), apiKey: undefined })

    await llm.run('summary', 材料)
    expect(ai.呼ばれた[0]?.model).toBe(DEFAULT_LLM_SETTINGS.workersAi.summary)
  })

  it('OpenAI互換の形（choices）で返すモデルからも文面を読む', async () => {
    const ai = バインディングの代役({ choices: [{ message: { role: 'assistant', content: 'あらすじです' } }] })
    const llm = createLlm({ ai, store: createFakeStore(), fetch: 通信の代役(OpenRouterの応答('使われない')), apiKey: undefined })

    expect(await llm.run('summary', 材料)).toBe('あらすじです')
  })

  it('設定の読み出しは1回だけにする（発言のたびに呼ばれる道に、余分なKVの読み出しを増やさないため）', async () => {
    const 元のstore = createFakeStore()
    const 読み出し: string[] = []
    const store = { ...元のstore, get: (key: string) => (読み出し.push(key), 元のstore.get(key)) }
    const ai = バインディングの代役()
    const llm = createLlm({ ai, store, fetch: 通信の代役(OpenRouterの応答('使われない')), apiKey: undefined })

    await llm.run('chat', 材料)
    await llm.run('chat', 材料)
    expect(読み出し.filter((key) => key === 'llm-settings')).toHaveLength(1)
  })
})

describe('createLlm（OpenRouter）', () => {
  it('保存された設定が OpenRouter なら、OpenRouter のAPIへ用途ごとのモデル名で送る', async () => {
    const store = createFakeStore()
    await saveLlmSettings(store, OpenRouterの設定)
    const fetchImpl = 通信の代役(OpenRouterの応答('こんばんは！'))
    const ai = バインディングの代役()
    const llm = createLlm({ ai, store, fetch: fetchImpl, apiKey: 'openrouter-test-key' })

    expect(await llm.run('summary', 材料)).toBe('こんばんは！')
    // Workers AI のバインディングは呼ばれない
    expect(ai.呼ばれた).toEqual([])

    const request = fetchImpl.呼ばれた[0]
    if (request === undefined) throw new Error('OpenRouter へ送られていません')
    expect(request.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(request.method).toBe('POST')
    expect(request.headers.get('Authorization')).toBe('Bearer openrouter-test-key')
    expect(await request.json()).toEqual({ model: 'anthropic/claude-3.5-haiku', messages: 材料.messages, max_tokens: 300 })
  })

  it('鍵が無ければ、黙って Workers AI へ落とさずに投げる（どこに設定するかを文面に出す）', async () => {
    const store = createFakeStore()
    await saveLlmSettings(store, OpenRouterの設定)
    const llm = createLlm({ ai: バインディングの代役(), store, fetch: 通信の代役(OpenRouterの応答('使われない')), apiKey: undefined })

    await expect(llm.run('chat', 材料)).rejects.toThrow('OPENROUTER_API_KEY')
  })

  it('OpenRouter が失敗を返したら、状態コードと本文を添えて投げる', async () => {
    const store = createFakeStore()
    await saveLlmSettings(store, OpenRouterの設定)
    const llm = createLlm({
      ai: バインディングの代役(),
      store,
      fetch: 通信の代役(new Response('{"error":{"message":"Insufficient credits"}}', { status: 402 })),
      apiKey: 'openrouter-test-key',
    })

    await expect(llm.run('chat', 材料)).rejects.toThrow(/402.*Insufficient credits/s)
  })

  it('応答が想定した形でなければ投げる（空の文面を作らせたことにしない）', async () => {
    const store = createFakeStore()
    await saveLlmSettings(store, OpenRouterの設定)
    const llm = createLlm({ ai: バインディングの代役(), store, fetch: 通信の代役(Response.json({ choices: [] })), apiKey: 'openrouter-test-key' })

    await expect(llm.run('chat', 材料)).rejects.toThrow('LLMの応答を読めません')
  })
})

describe('readResponse', () => {
  it('response に文面を入れて返すモデルから読む', () => {
    expect(readResponse({ response: 'こんばんは！' })).toBe('こんばんは！')
  })

  it('OpenAI互換の形（choices）で返すモデルからも読む', () => {
    expect(readResponse({ choices: [{ message: { role: 'assistant', content: 'こんばんは！' } }] })).toBe('こんばんは！')
  })

  it('どちらの形でもなければ、黙って捨てずに投げる', () => {
    expect(() => readResponse({ choices: [] })).toThrow('LLMの応答を読めません')
  })
})
