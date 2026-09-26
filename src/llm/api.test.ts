/**
 * LLMの設定の読み書き（api.ts）のテスト
 *
 * 実際の通信はせず、fetch を差し替える（speech/api.test.ts と同じ形）。
 * 確かめること:
 * - 管理用の経路（/api/admin/llm）を読み書きすること
 * - AIを使う4か所ぶんの設定を、そのまま受け取れること
 * - 応答が想定した形でなければエラーにすること（黙って既定の提供元に倒さない）
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../core/api'
import { createLlmApi, type LlmSettings } from './api'

/** 短い文を作る3か所の既定のモデル */
const 軽いモデル = { 'workers-ai': '@cf/meta/llama-3.1-8b-instruct-fp8', openrouter: 'meta-llama/llama-3.1-8b-instruct' }

/** Workerが返す、保存済みの設定。あらすじだけ OpenRouter に切り替えている */
const 保存済みの設定: LlmSettings = {
  usages: {
    aiChat: { provider: 'workers-ai', models: { ...軽いモデル } },
    sideSuper: { provider: 'workers-ai', models: { ...軽いモデル } },
    viewerSummary: { provider: 'workers-ai', models: { ...軽いモデル } },
    streamSummary: {
      provider: 'openrouter',
      models: { 'workers-ai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast', openrouter: 'anthropic/claude-3.5-haiku' },
    },
  },
}

/** 呼ばれた内容を記録し、決めた応答を返す fetch */
const 応答を返すfetch = (status: number, body: unknown) => {
  const 呼び出し: { path: string; method: string; body: string }[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    呼び出し.push({ path: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? '') })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { 呼び出し, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('createLlmApi', () => {
  it('保存済みの設定と、鍵が設定されているかを読む', async () => {
    const { 呼び出し, fetchImpl } = 応答を返すfetch(200, { ...保存済みの設定, apiKeyConfigured: true })

    expect(await createLlmApi(fetchImpl).load()).toEqual({ settings: 保存済みの設定, apiKeyConfigured: true })
    expect(呼び出し).toEqual([{ path: '/api/admin/llm', method: 'GET', body: '' }])
  })

  it('設定をまるごと置き換えて保存し、保存後の設定を受け取る', async () => {
    const { 呼び出し, fetchImpl } = 応答を返すfetch(200, 保存済みの設定)

    expect(await createLlmApi(fetchImpl).save(保存済みの設定)).toEqual(保存済みの設定)
    expect(呼び出し).toEqual([{ path: '/api/admin/llm', method: 'PUT', body: JSON.stringify(保存済みの設定) }])
  })

  it('Workerが問題点を返したら ApiError にする（画面が理由を並べられるようにする）', async () => {
    const { fetchImpl } = 応答を返すfetch(400, {
      error: {
        code: 'invalid-config',
        message: 'LLMの設定に問題があります',
        problems: ['aiChat.models.openrouter: モデル名を200文字以内で指定してください'],
      },
    })

    await expect(createLlmApi(fetchImpl).save(保存済みの設定)).rejects.toThrow(ApiError)
  })

  it('知らない提供元が返ってきたらエラーにする（黙って Workers AI に倒さない）', async () => {
    const { fetchImpl } = 応答を返すfetch(200, {
      usages: { ...保存済みの設定.usages, aiChat: { provider: 'openai', models: { ...軽いモデル } } },
    })

    await expect(createLlmApi(fetchImpl).load()).rejects.toThrow('/api/admin/llm')
  })

  it('使う箇所が1つでも欠けていればエラーにする', async () => {
    const 残り = { ...保存済みの設定.usages, streamSummary: undefined }
    const { fetchImpl } = 応答を返すfetch(200, { usages: 残り })

    await expect(createLlmApi(fetchImpl).load()).rejects.toThrow('/api/admin/llm')
  })

  it('提供元ごとのモデル名が足りなければエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(200, {
      usages: { ...保存済みの設定.usages, sideSuper: { provider: 'workers-ai', models: { 'workers-ai': '@cf/meta/llama-3.1-8b-instruct-fp8' } } },
    })

    await expect(createLlmApi(fetchImpl).load()).rejects.toThrow('/api/admin/llm')
  })
})
