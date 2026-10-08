/**
 * LLMの設定の読み書き（api.ts）のテスト
 *
 * 実際の通信はせず、fetch を差し替える（speech/api.test.ts と同じ形）。
 * 確かめること:
 * - 管理用の経路（/api/admin/llm）を読み書きすること
 * - AIを使う5か所ぶんの設定を、そのまま受け取れること
 * - 字幕の翻訳の提供元の設定（/api/admin/translation）と DeepL の使用量を読み書きできること
 * - 提供元ごとに選べるモデルの一覧を読めること（画面の選択欄に出す候補）
 * - 応答が想定した形でなければエラーにすること（黙って既定の提供元に倒さない）
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../core/api'
import { createLlmApi, type LlmSettings } from './api'

/** 短い文を作る3か所の既定のモデル */
const lightModel = { 'workers-ai': '@cf/meta/llama-3.1-8b-instruct-fp8', openrouter: 'meta-llama/llama-3.1-8b-instruct' }

/** Workerが返す、保存済みの設定。あらすじだけ OpenRouter に切り替えている */
const savedSettings: LlmSettings = {
  usages: {
    translation: { provider: 'workers-ai', models: { ...lightModel } },
    aiChat: { provider: 'workers-ai', models: { ...lightModel } },
    sideSuper: { provider: 'workers-ai', models: { ...lightModel } },
    viewerSummary: { provider: 'workers-ai', models: { ...lightModel } },
    streamSummary: {
      provider: 'openrouter',
      models: { 'workers-ai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast', openrouter: 'anthropic/claude-3.5-haiku' },
    },
    streamTitle: { provider: 'workers-ai', models: { 'workers-ai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast', openrouter: 'meta-llama/llama-3.3-70b-instruct' } },
    townTour: { provider: 'workers-ai', models: { 'workers-ai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast', openrouter: 'meta-llama/llama-3.3-70b-instruct' } },
    townBond: { provider: 'openrouter', models: { 'workers-ai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast', openrouter: 'google/gemini-3.8-flash' } },
    autoText: { provider: 'workers-ai', models: { 'workers-ai': '@cf/meta/llama-3.1-8b-instruct-fp8', openrouter: 'meta-llama/llama-3.1-8b-instruct' } },
  },
}

/** 呼ばれた内容を記録し、決めた応答を返す fetch */
const fetchReturning = (status: number, body: unknown) => {
  const calls: { path: string; method: string; body: string }[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ path: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? '') })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('createLlmApi', () => {
  it('保存済みの設定と、鍵が設定されているかを読む', async () => {
    const { calls, fetchImpl } = fetchReturning(200, { ...savedSettings, apiKeyConfigured: true })

    expect(await createLlmApi(fetchImpl).load()).toEqual({ settings: savedSettings, apiKeyConfigured: true })
    expect(calls).toEqual([{ path: '/api/admin/llm', method: 'GET', body: '' }])
  })

  it('設定をまるごと置き換えて保存し、保存後の設定を受け取る', async () => {
    const { calls, fetchImpl } = fetchReturning(200, savedSettings)

    expect(await createLlmApi(fetchImpl).save(savedSettings)).toEqual(savedSettings)
    expect(calls).toEqual([{ path: '/api/admin/llm', method: 'PUT', body: JSON.stringify(savedSettings) }])
  })

  it('Workerが問題点を返したら ApiError にする（画面が理由を並べられるようにする）', async () => {
    const { fetchImpl } = fetchReturning(400, {
      error: {
        code: 'invalid-config',
        message: 'LLMの設定に問題があります',
        problems: ['aiChat.models.openrouter: モデル名を200文字以内で指定してください'],
      },
    })

    await expect(createLlmApi(fetchImpl).save(savedSettings)).rejects.toThrow(ApiError)
  })

  it('知らない提供元が返ってきたらエラーにする（黙って Workers AI に倒さない）', async () => {
    const { fetchImpl } = fetchReturning(200, {
      usages: { ...savedSettings.usages, aiChat: { provider: 'openai', models: { ...lightModel } } },
    })

    await expect(createLlmApi(fetchImpl).load()).rejects.toThrow('/api/admin/llm')
  })

  it('使う箇所が1つでも欠けていればエラーにする', async () => {
    const rest = { ...savedSettings.usages, streamSummary: undefined }
    const { fetchImpl } = fetchReturning(200, { usages: rest })

    await expect(createLlmApi(fetchImpl).load()).rejects.toThrow('/api/admin/llm')
  })

  it('提供元ごとのモデル名が足りなければエラーにする', async () => {
    const { fetchImpl } = fetchReturning(200, {
      usages: { ...savedSettings.usages, sideSuper: { provider: 'workers-ai', models: { 'workers-ai': '@cf/meta/llama-3.1-8b-instruct-fp8' } } },
    })

    await expect(createLlmApi(fetchImpl).load()).rejects.toThrow('/api/admin/llm')
  })
})

describe('createLlmApi.listModels', () => {
  it('提供元を指定して、選べるモデルの一覧を読む', async () => {
    const { calls, fetchImpl } = fetchReturning(200, {
      models: [
        { id: '@cf/meta/llama-3.1-8b-instruct-fp8', name: 'Llama 3.1 8B Instruct（fp8）' },
        { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 3.3 70B Instruct（fp8・高速）' },
      ],
    })

    expect(await createLlmApi(fetchImpl).listModels('workers-ai')).toEqual([
      { id: '@cf/meta/llama-3.1-8b-instruct-fp8', name: 'Llama 3.1 8B Instruct（fp8）' },
      { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 3.3 70B Instruct（fp8・高速）' },
    ])
    expect(calls).toEqual([{ path: '/api/admin/llm/models?provider=workers-ai', method: 'GET', body: '' }])
  })

  it('一覧が空、または想定した形でなければエラーにする（選べない選択欄を出さない）', async () => {
    await expect(createLlmApi(fetchReturning(200, { models: [] }).fetchImpl).listModels('openrouter')).rejects.toThrow('/api/admin/llm/models')
    await expect(createLlmApi(fetchReturning(200, { models: [{ id: 1 }] }).fetchImpl).listModels('openrouter')).rejects.toThrow(
      '/api/admin/llm/models',
    )
  })

  it('Workerが失敗を返したら ApiError にする（画面が理由を出せるようにする）', async () => {
    const { fetchImpl } = fetchReturning(502, {
      error: { code: 'internal-error', message: 'OpenRouter のモデルの一覧を取れませんでした（503）' },
    })

    await expect(createLlmApi(fetchImpl).listModels('openrouter')).rejects.toThrow(ApiError)
  })
})

describe('createLlmApi.loadUsage', () => {
  it('日ごとの使用状況を読む', async () => {
    const { calls, fetchImpl } = fetchReturning(200, {
      days: [
        {
          day: '2026-09-27',
          usage: 'streamSummary',
          provider: 'openrouter',
          model: 'anthropic/claude-3.5-haiku',
          calls: 12,
          failures: 1,
          promptTokens: 9000,
          completionTokens: 2400,
          costUsd: 0.0054,
        },
      ],
    })

    const days = await createLlmApi(fetchImpl).loadUsage()

    expect(days).toEqual([
      {
        day: '2026-09-27',
        usage: 'streamSummary',
        provider: 'openrouter',
        model: 'anthropic/claude-3.5-haiku',
        calls: 12,
        failures: 1,
        promptTokens: 9000,
        completionTokens: 2400,
        costUsd: 0.0054,
      },
    ])
    expect(calls).toEqual([{ path: '/api/admin/llm/usage', method: 'GET', body: '' }])
  })

  it('まだ一度も呼んでいなければ、空の一覧として受け取る', async () => {
    const { fetchImpl } = fetchReturning(200, { days: [] })

    expect(await createLlmApi(fetchImpl).loadUsage()).toEqual([])
  })

  it('応答が想定した形でなければエラーにする（数えられていないことを 0 と見せない）', async () => {
    const { fetchImpl } = fetchReturning(200, { days: [{ day: '2026-09-27', usage: 'aiChat' }] })

    await expect(createLlmApi(fetchImpl).loadUsage()).rejects.toThrow('/api/admin/llm/usage')
  })
})

describe('createLlmApi.loadCredits', () => {
  it('OpenRouter の残高を読む', async () => {
    const { calls, fetchImpl } = fetchReturning(200, { totalCredits: 10, totalUsage: 2.5, remaining: 7.5 })

    expect(await createLlmApi(fetchImpl).loadCredits()).toEqual({ totalCredits: 10, totalUsage: 2.5, remaining: 7.5 })
    expect(calls).toEqual([{ path: '/api/admin/llm/credits', method: 'GET', body: '' }])
  })

  it('応答が想定した形でなければエラーにする（残高を 0 と見せない）', async () => {
    const { fetchImpl } = fetchReturning(200, { totalCredits: 10 })

    await expect(createLlmApi(fetchImpl).loadCredits()).rejects.toThrow('/api/admin/llm/credits')
  })

  it('鍵が無いとWorkerが断ったら ApiError にする（画面が理由を出せるようにする）', async () => {
    const { fetchImpl } = fetchReturning(400, {
      error: { code: 'no-api-key', message: 'OpenRouter のAPIキーが設定されていないため、残高を読めません' },
    })

    await expect(createLlmApi(fetchImpl).loadCredits()).rejects.toThrow(ApiError)
  })
})

describe('字幕の翻訳の設定', () => {
  it('提供元と、DeepL の鍵が設定されているかを読む', async () => {
    const { calls, fetchImpl } = fetchReturning(200, { provider: 'deepl', deeplKeyConfigured: true })

    expect(await createLlmApi(fetchImpl).loadTranslation()).toEqual({ provider: 'deepl', deeplKeyConfigured: true })
    expect(calls[0]?.path).toBe('/api/admin/translation')
  })

  it('知らない提供元が返ってきたらエラーにする（黙って「訳さない」に倒さない）', async () => {
    const { fetchImpl } = fetchReturning(200, { provider: 'google', deeplKeyConfigured: false })

    await expect(createLlmApi(fetchImpl).loadTranslation()).rejects.toThrow('/api/admin/translation')
  })

  it('選んだ提供元を保存する', async () => {
    const { calls, fetchImpl } = fetchReturning(200, { provider: 'm2m100' })

    expect(await createLlmApi(fetchImpl).saveTranslation('m2m100')).toBe('m2m100')
    expect(calls[0]).toMatchObject({ path: '/api/admin/translation', method: 'PUT', body: JSON.stringify({ provider: 'm2m100' }) })
  })

  it('DeepL の今月の使用量を読む', async () => {
    const { calls, fetchImpl } = fetchReturning(200, { characterCount: 1200, characterLimit: 500000 })

    expect(await createLlmApi(fetchImpl).loadDeeplUsage()).toEqual({ characterCount: 1200, characterLimit: 500000 })
    expect(calls[0]?.path).toBe('/api/admin/translation/deepl-usage')
  })
})
