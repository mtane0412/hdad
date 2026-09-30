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
 * - 呼び出しの使用状況（回数・トークン数・実費）を、成功でも失敗でも記録すること（管理画面に出すため）
 * - 使用状況の記録に失敗しても、文面はそのまま返し、失敗を collection_failures に残すこと
 */
import { describe, expect, it } from 'vitest'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'
import { DEFAULT_LLM_SETTINGS, saveLlmSettings, type LlmSettings } from './llm-config'
import { createLlm, readResponse, type WorkersAi } from './llm'
import { TimeoutError } from './timeout'

const now = Date.parse('2026-09-27T01:23:45.000Z')

/**
 * 使用状況の記録に要るもの（D1と現在時刻）。
 *
 * 記録そのものを確かめるテストだけが自前のデータベースを渡し、ほかのテストは使い捨てのものでよい。
 */
const recordCondition = () => ({ db: createFakeDatabase(), now: () => now })

/** 送る材料。中身はこのテストでは問わない */
const material = { messages: [{ role: 'user' as const, content: 'こんばんは！' }], maxTokens: 300 }

/** Workers AI のバインディングの代役。渡された引数を控える */
const fakeBinding = (result: unknown = { response: 'こんばんは！' }): WorkersAi & { called: { model: string; input: Record<string, unknown> }[] } => {
  const called: { model: string; input: Record<string, unknown> }[] = []
  return { called, run: (model, input) => (called.push({ model, input }), Promise.resolve(result)) }
}

/** OpenRouter の応答の代役。渡されたリクエストを控える */
const fakeFetch = (response: Response): typeof fetch & { called: Request[] } => {
  const called: Request[] = []
  const impl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    called.push(new Request(input as RequestInfo, init))
    return Promise.resolve(response)
  }
  return Object.assign(impl as typeof fetch, { called })
}

const openRouterResponse = (content: string): Response => Response.json({ choices: [{ message: { role: 'assistant', content } }] })

/** あらすじ（streamSummary）だけを OpenRouter にした設定。ほかの3か所は Workers AI のまま */
const openRouterConfig: LlmSettings = {
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
    const ai = fakeBinding()
    const llm = createLlm({ ...recordCondition(), ai, store: createFakeStore(), fetch: fakeFetch(openRouterResponse('使われない')), apiKey: undefined })

    expect(await llm.run('aiChat', material)).toBe('こんばんは！')
    expect(ai.called).toEqual([
      { model: DEFAULT_LLM_SETTINGS.usages.aiChat.models['workers-ai'], input: { messages: material.messages, max_tokens: 300 } },
    ])
  })

  it('あらすじ（streamSummary）では、あらすじ用のモデルを使う', async () => {
    const ai = fakeBinding()
    const llm = createLlm({ ...recordCondition(), ai, store: createFakeStore(), fetch: fakeFetch(openRouterResponse('使われない')), apiKey: undefined })

    await llm.run('streamSummary', material)
    expect(ai.called[0]?.model).toBe(DEFAULT_LLM_SETTINGS.usages.streamSummary.models['workers-ai'])
  })

  it('OpenAI互換の形（choices）で返すモデルからも文面を読む', async () => {
    const ai = fakeBinding({ choices: [{ message: { role: 'assistant', content: 'あらすじです' } }] })
    const llm = createLlm({ ...recordCondition(), ai, store: createFakeStore(), fetch: fakeFetch(openRouterResponse('使われない')), apiKey: undefined })

    expect(await llm.run('streamSummary', material)).toBe('あらすじです')
  })

  it('設定の読み出しは1回だけにする（発言のたびに呼ばれる道に、余分なKVの読み出しを増やさないため）', async () => {
    const originalStore = createFakeStore()
    const readOut: string[] = []
    const store = { ...originalStore, get: (key: string) => (readOut.push(key), originalStore.get(key)) }
    const ai = fakeBinding()
    const llm = createLlm({ ...recordCondition(), ai, store, fetch: fakeFetch(openRouterResponse('使われない')), apiKey: undefined })

    await llm.run('aiChat', material)
    await llm.run('sideSuper', material)
    expect(readOut.filter((key) => key === 'llm-settings')).toHaveLength(1)
  })
})

describe('createLlm（OpenRouter）', () => {
  it('その箇所の提供元が OpenRouter なら、OpenRouter のAPIへその箇所のモデル名で送る', async () => {
    const store = createFakeStore()
    await saveLlmSettings(store, openRouterConfig)
    const fetchImpl = fakeFetch(openRouterResponse('こんばんは！'))
    const ai = fakeBinding()
    const llm = createLlm({ ...recordCondition(), ai, store, fetch: fetchImpl, apiKey: 'openrouter-test-key' })

    expect(await llm.run('streamSummary', material)).toBe('こんばんは！')
    // Workers AI のバインディングは呼ばれない
    expect(ai.called).toEqual([])

    const request = fetchImpl.called[0]
    if (request === undefined) throw new Error('OpenRouter へ送られていません')
    expect(request.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(request.method).toBe('POST')
    expect(request.headers.get('Authorization')).toBe('Bearer openrouter-test-key')
    expect(await request.json()).toEqual({
      model: 'anthropic/claude-3.5-haiku',
      messages: material.messages,
      max_tokens: 300,
      // 推論に枠を食わせず本文を返させる（推論モデルでは max_tokens を思考トークンが使い切ってしまう）
      reasoning: { enabled: false },
      // この呼び出しの実費を応答に入れてもらう（管理画面の使用状況に出すため）
      usage: { include: true },
    })
  })

  it('箇所ごとに提供元が違えば、それぞれの呼び先へ送る（あらすじだけ OpenRouter にする使い方）', async () => {
    const store = createFakeStore()
    await saveLlmSettings(store, openRouterConfig)
    const fetchImpl = fakeFetch(openRouterResponse('あらすじです'))
    const ai = fakeBinding({ response: 'こんばんは！' })
    const llm = createLlm({ ...recordCondition(), ai, store, fetch: fetchImpl, apiKey: 'openrouter-test-key' })

    expect(await llm.run('aiChat', material)).toBe('こんばんは！')
    expect(await llm.run('streamSummary', material)).toBe('あらすじです')

    // チャットの文面は Workers AI のバインディングへ、あらすじは OpenRouter へ送られている
    expect(ai.called.map(({ model }) => model)).toEqual([DEFAULT_LLM_SETTINGS.usages.aiChat.models['workers-ai']])
    expect(fetchImpl.called).toHaveLength(1)
  })

  it('鍵が無ければ、黙って Workers AI へ落とさずに投げる（どこに設定するかを文面に出す）', async () => {
    const store = createFakeStore()
    await saveLlmSettings(store, openRouterConfig)
    const llm = createLlm({ ...recordCondition(), ai: fakeBinding(), store, fetch: fakeFetch(openRouterResponse('使われない')), apiKey: undefined })

    await expect(llm.run('streamSummary', material)).rejects.toThrow('OPENROUTER_API_KEY')
  })

  it('OpenRouter が失敗を返したら、状態コードと本文を添えて投げる', async () => {
    const store = createFakeStore()
    await saveLlmSettings(store, openRouterConfig)
    const llm = createLlm({
      ...recordCondition(),
      ai: fakeBinding(),
      store,
      fetch: fakeFetch(new Response('{"error":{"message":"Insufficient credits"}}', { status: 402 })),
      apiKey: 'openrouter-test-key',
    })

    await expect(llm.run('streamSummary', material)).rejects.toThrow(/402.*Insufficient credits/s)
  })

  it('応答が想定した形でなければ投げる（空の文面を作らせたことにしない）', async () => {
    const store = createFakeStore()
    await saveLlmSettings(store, openRouterConfig)
    const llm = createLlm({ ...recordCondition(), ai: fakeBinding(), store, fetch: fakeFetch(Response.json({ choices: [] })), apiKey: 'openrouter-test-key' })

    await expect(llm.run('streamSummary', material)).rejects.toThrow('LLMの応答を読めません')
  })
})


describe('createLlm（使用状況の記録）', () => {
  /** 記録された1行を読む（テーブルの中身をそのまま確かめる） */
  const readRecords = (db: ReturnType<typeof createFakeDatabase>) =>
    db.sqlite.prepare('SELECT day, usage, provider, model, calls, failures, prompt_tokens, completion_tokens, cost_usd FROM llm_usage').all()

  it('Workers AI の応答に入っていたトークン数を、箇所とモデルごとに記録する', async () => {
    const db = createFakeDatabase()
    const ai = fakeBinding({ response: 'こんばんは！', usage: { prompt_tokens: 120, completion_tokens: 30 } })
    const llm = createLlm({ db, now: () => now, ai, store: createFakeStore(), fetch: fakeFetch(openRouterResponse('使われない')), apiKey: undefined })

    await llm.run('aiChat', material)

    expect(readRecords(db)).toEqual([
      {
        day: '2026-09-27',
        usage: 'aiChat',
        provider: 'workers-ai',
        model: DEFAULT_LLM_SETTINGS.usages.aiChat.models['workers-ai'],
        calls: 1,
        failures: 0,
        prompt_tokens: 120,
        completion_tokens: 30,
        // Workers AI は Neurons の消費量を返さないので、実費は積めない
        cost_usd: 0,
      },
    ])
  })

  it('トークン数を返さないモデルでも、呼び出した回数だけは記録する', async () => {
    const db = createFakeDatabase()
    const llm = createLlm({
      db,
      now: () => now,
      ai: fakeBinding({ response: 'こんばんは！' }),
      store: createFakeStore(),
      fetch: fakeFetch(openRouterResponse('使われない')),
      apiKey: undefined,
    })

    await llm.run('sideSuper', material)

    expect(readRecords(db)).toMatchObject([{ usage: 'sideSuper', calls: 1, prompt_tokens: 0, completion_tokens: 0 }])
  })

  it('OpenRouter には実費を返させ（usage.include）、返ってきた実費を記録する', async () => {
    const db = createFakeDatabase()
    const store = createFakeStore()
    await saveLlmSettings(store, openRouterConfig)
    const fetchImpl = fakeFetch(
      Response.json({
        choices: [{ message: { role: 'assistant', content: 'あらすじです' } }],
        usage: { prompt_tokens: 900, completion_tokens: 200, cost: 0.000_45 },
      }),
    )
    const llm = createLlm({ db, now: () => now, ai: fakeBinding(), store, fetch: fetchImpl, apiKey: 'openrouter-test-key' })

    await llm.run('streamSummary', material)

    const request = fetchImpl.called[0]
    if (request === undefined) throw new Error('OpenRouter へ送られていません')
    expect(await request.json()).toMatchObject({ usage: { include: true } })
    expect(readRecords(db)).toMatchObject([
      { usage: 'streamSummary', provider: 'openrouter', model: 'anthropic/claude-3.5-haiku', calls: 1, prompt_tokens: 900, completion_tokens: 200, cost_usd: 0.000_45 },
    ])
  })

  it('失敗した呼び出しは failures として記録してから投げる（無料枠切れの回数を画面から読めるようにするため）', async () => {
    const db = createFakeDatabase()
    const store = createFakeStore()
    await saveLlmSettings(store, openRouterConfig)
    const llm = createLlm({
      db,
      now: () => now,
      ai: fakeBinding(),
      store,
      fetch: fakeFetch(new Response('{"error":{"message":"Insufficient credits"}}', { status: 402 })),
      apiKey: 'openrouter-test-key',
    })

    await expect(llm.run('streamSummary', material)).rejects.toThrow('402')
    expect(readRecords(db)).toMatchObject([{ usage: 'streamSummary', provider: 'openrouter', calls: 0, failures: 1 }])
  })

  it('記録に失敗しても文面はそのまま返し、失敗を collection_failures に残す', async () => {
    const real = createFakeDatabase()
    // 使用状況の記録だけが失敗するデータベース（D1の書き込みの枠を使い切った場合の再現）
    const db = {
      ...real,
      prepare: (sql: string) => {
        if (sql.includes('llm_usage')) throw new Error('D1の書き込みの枠を使い切りました')
        return real.prepare(sql)
      },
    }
    const llm = createLlm({
      db,
      now: () => now,
      ai: fakeBinding({ response: 'こんばんは！' }),
      store: createFakeStore(),
      fetch: fakeFetch(openRouterResponse('使われない')),
      apiKey: undefined,
    })

    expect(await llm.run('aiChat', material)).toBe('こんばんは！')
    expect(real.sqlite.prepare('SELECT code, message FROM collection_failures').all()).toMatchObject([
      { code: 'llm-usage-record-failed', message: expect.stringContaining('D1の書き込みの枠') },
    ])
  })
})

describe('readResponse', () => {
  it('上限に当たって本文が空なら、原因と直し方が読める文面で投げる', () => {
    const response = { choices: [{ finish_reason: 'length', native_finish_reason: 'max_output_tokens', message: { role: 'assistant', content: null } }] }
    expect(() => readResponse(response)).toThrow(/上限.*推論モデル/s)
  })

  it('上限に当たって本文が空の文字列でも、同じ文面で投げる（空の文面を作らせたことにしない）', () => {
    expect(() => readResponse({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }] })).toThrow(/上限.*推論モデル/s)
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

describe('時間制限（issue #126）', () => {
  it('Workers AI が応答を返さないと、待ち続けずに TimeoutError にする', async () => {
    const ai: WorkersAi = { run: () => new Promise<unknown>(() => undefined) }
    const llm = createLlm({
      ...recordCondition(),
      ai,
      store: createFakeStore(),
      fetch: fakeFetch(openRouterResponse('使われない')),
      apiKey: undefined,
      timeoutMs: 10,
    })

    await expect(llm.run('aiChat', material)).rejects.toBeInstanceOf(TimeoutError)
  })

  it('OpenRouter が応答を返さないと、待ち続けずに TimeoutError にする', async () => {
    const store = createFakeStore()
    await saveLlmSettings(store, openRouterConfig)
    const fetchImpl = (async () => await new Promise<Response>(() => undefined)) as typeof fetch
    const llm = createLlm({ ...recordCondition(), ai: fakeBinding(), store, fetch: fetchImpl, apiKey: 'openrouter-test-key', timeoutMs: 10 })

    await expect(llm.run('streamSummary', material)).rejects.toBeInstanceOf(TimeoutError)
  })
})
