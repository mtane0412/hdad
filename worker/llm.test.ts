/**
 * LLMの呼び出し（llm.ts）のテスト
 *
 * 呼び出し側は「どこで使うか」（aiChat・sideSuper・viewerSummary・streamSummary）だけを指名し、
 * どの提供元のどのモデルを使うかは保存された設定（llm-config.ts）が決める。ここで確かめるのは次の点である。
 * - 使う箇所ごとに、その箇所で選ばれた提供元のモデル名が渡ること
 * - 箇所ごとに提供元が違っても、それぞれの呼び先へ送ること（あらすじだけ OpenRouter にする使い方）
 * - Workers AI と OpenRouter のどちらの応答からも文面を読めること
 * - OpenRouter を選んでいるのに鍵が無い・OpenRouter が失敗を返した場合に、黙って Workers AI へ落とさず投げること
 * - OpenRouter へは推論を切って送ること（推論モデルでは思考トークンが max_tokens を使い切り、本文が空で返るため）
 * - 上限に当たって本文が空で返ったときは、原因（推論モデル）が読める文面で投げること
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

/** あらすじ（streamSummary）だけを OpenRouter にした設定。ほかの3か所は Workers AI のまま */
const OpenRouterの設定: LlmSettings = {
  usages: {
    ...DEFAULT_LLM_SETTINGS.usages,
    streamSummary: {
      provider: 'openrouter',
      models: { 'workers-ai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast', openrouter: 'anthropic/claude-3.5-haiku' },
    },
  },
}

describe('createLlm（Workers AI）', () => {
  it('未保存なら Workers AI のバインディングを、その箇所のモデル名で呼ぶ', async () => {
    const ai = バインディングの代役()
    const llm = createLlm({ ai, store: createFakeStore(), fetch: 通信の代役(OpenRouterの応答('使われない')), apiKey: undefined })

    expect(await llm.run('aiChat', 材料)).toBe('こんばんは！')
    expect(ai.呼ばれた).toEqual([
      { model: DEFAULT_LLM_SETTINGS.usages.aiChat.models['workers-ai'], input: { messages: 材料.messages, max_tokens: 300 } },
    ])
  })

  it('あらすじ（streamSummary）では、あらすじ用のモデルを使う', async () => {
    const ai = バインディングの代役()
    const llm = createLlm({ ai, store: createFakeStore(), fetch: 通信の代役(OpenRouterの応答('使われない')), apiKey: undefined })

    await llm.run('streamSummary', 材料)
    expect(ai.呼ばれた[0]?.model).toBe(DEFAULT_LLM_SETTINGS.usages.streamSummary.models['workers-ai'])
  })

  it('OpenAI互換の形（choices）で返すモデルからも文面を読む', async () => {
    const ai = バインディングの代役({ choices: [{ message: { role: 'assistant', content: 'あらすじです' } }] })
    const llm = createLlm({ ai, store: createFakeStore(), fetch: 通信の代役(OpenRouterの応答('使われない')), apiKey: undefined })

    expect(await llm.run('streamSummary', 材料)).toBe('あらすじです')
  })

  it('設定の読み出しは1回だけにする（発言のたびに呼ばれる道に、余分なKVの読み出しを増やさないため）', async () => {
    const 元のstore = createFakeStore()
    const 読み出し: string[] = []
    const store = { ...元のstore, get: (key: string) => (読み出し.push(key), 元のstore.get(key)) }
    const ai = バインディングの代役()
    const llm = createLlm({ ai, store, fetch: 通信の代役(OpenRouterの応答('使われない')), apiKey: undefined })

    await llm.run('aiChat', 材料)
    await llm.run('sideSuper', 材料)
    expect(読み出し.filter((key) => key === 'llm-settings')).toHaveLength(1)
  })
})

describe('createLlm（OpenRouter）', () => {
  it('その箇所の提供元が OpenRouter なら、OpenRouter のAPIへその箇所のモデル名で送る', async () => {
    const store = createFakeStore()
    await saveLlmSettings(store, OpenRouterの設定)
    const fetchImpl = 通信の代役(OpenRouterの応答('こんばんは！'))
    const ai = バインディングの代役()
    const llm = createLlm({ ai, store, fetch: fetchImpl, apiKey: 'openrouter-test-key' })

    expect(await llm.run('streamSummary', 材料)).toBe('こんばんは！')
    // Workers AI のバインディングは呼ばれない
    expect(ai.呼ばれた).toEqual([])

    const request = fetchImpl.呼ばれた[0]
    if (request === undefined) throw new Error('OpenRouter へ送られていません')
    expect(request.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(request.method).toBe('POST')
    expect(request.headers.get('Authorization')).toBe('Bearer openrouter-test-key')
    expect(await request.json()).toEqual({
      model: 'anthropic/claude-3.5-haiku',
      messages: 材料.messages,
      max_tokens: 300,
      // 推論に枠を食わせず本文を返させる（推論モデルでは max_tokens を思考トークンが使い切ってしまう）
      reasoning: { enabled: false },
    })
  })

  it('箇所ごとに提供元が違えば、それぞれの呼び先へ送る（あらすじだけ OpenRouter にする使い方）', async () => {
    const store = createFakeStore()
    await saveLlmSettings(store, OpenRouterの設定)
    const fetchImpl = 通信の代役(OpenRouterの応答('あらすじです'))
    const ai = バインディングの代役({ response: 'こんばんは！' })
    const llm = createLlm({ ai, store, fetch: fetchImpl, apiKey: 'openrouter-test-key' })

    expect(await llm.run('aiChat', 材料)).toBe('こんばんは！')
    expect(await llm.run('streamSummary', 材料)).toBe('あらすじです')

    // チャットの文面は Workers AI のバインディングへ、あらすじは OpenRouter へ送られている
    expect(ai.呼ばれた.map(({ model }) => model)).toEqual([DEFAULT_LLM_SETTINGS.usages.aiChat.models['workers-ai']])
    expect(fetchImpl.呼ばれた).toHaveLength(1)
  })

  it('鍵が無ければ、黙って Workers AI へ落とさずに投げる（どこに設定するかを文面に出す）', async () => {
    const store = createFakeStore()
    await saveLlmSettings(store, OpenRouterの設定)
    const llm = createLlm({ ai: バインディングの代役(), store, fetch: 通信の代役(OpenRouterの応答('使われない')), apiKey: undefined })

    await expect(llm.run('streamSummary', 材料)).rejects.toThrow('OPENROUTER_API_KEY')
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

    await expect(llm.run('streamSummary', 材料)).rejects.toThrow(/402.*Insufficient credits/s)
  })

  it('応答が想定した形でなければ投げる（空の文面を作らせたことにしない）', async () => {
    const store = createFakeStore()
    await saveLlmSettings(store, OpenRouterの設定)
    const llm = createLlm({ ai: バインディングの代役(), store, fetch: 通信の代役(Response.json({ choices: [] })), apiKey: 'openrouter-test-key' })

    await expect(llm.run('streamSummary', 材料)).rejects.toThrow('LLMの応答を読めません')
  })
})

describe('readResponse', () => {
  it('上限に当たって本文が空なら、原因と直し方が読める文面で投げる', () => {
    const 応答 = { choices: [{ finish_reason: 'length', native_finish_reason: 'max_output_tokens', message: { role: 'assistant', content: null } }] }
    expect(() => readResponse(応答)).toThrow(/上限.*推論モデル/s)
  })

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
