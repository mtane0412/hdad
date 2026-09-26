// @vitest-environment jsdom
/**
 * LLMのページのテスト
 *
 * 確かめること:
 * - AIを使う4か所ぶんの設定を読み込んで、箇所ごとに提供元とモデル名を出すこと
 * - 箇所ごとに別の提供元を選んで保存できること（あらすじだけ OpenRouter にする使い方）
 * - 提供元ごとのモデル名を別々に持つこと（切り替えて戻しても前のモデル名が消えない）
 * - OpenRouter を選んでいる箇所があるのに鍵が設定されていなければ、その場で知らせること
 * - Workerが返した問題点を、そのまま画面に並べること（検証はWorkerだけが持つ）
 * - 設定を読めなかったときは、黙って既定に倒さず理由を出すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test } from 'vitest'
import { ApiError } from '@/core/api'
import { LlmPage } from './llm-page'
import type { LlmApi, LlmSettings, LlmState } from './api'

afterEach(cleanup)

/** 短い文を作る3か所の既定のモデル */
const 軽いモデル = { 'workers-ai': '@cf/meta/llama-3.1-8b-instruct-fp8', openrouter: 'meta-llama/llama-3.1-8b-instruct' }
/** あらすじの既定のモデル */
const 大きいモデル = { 'workers-ai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast', openrouter: 'meta-llama/llama-3.3-70b-instruct' }

/** 前提: Workerに保存されている、既定のままの設定（どこも Workers AI） */
const 保存済みの設定: LlmSettings = {
  usages: {
    aiChat: { provider: 'workers-ai', models: { ...軽いモデル } },
    sideSuper: { provider: 'workers-ai', models: { ...軽いモデル } },
    viewerSummary: { provider: 'workers-ai', models: { ...軽いモデル } },
    streamSummary: { provider: 'workers-ai', models: { ...大きいモデル } },
  },
}

/** 読み書きを記録する、LLMの設定のAPI */
const llmApi = (state: Partial<LlmState> = {}): LlmApi & { saved: LlmSettings[] } => {
  const saved: LlmSettings[] = []
  return {
    saved,
    load: () => Promise.resolve({ settings: state.settings ?? 保存済みの設定, apiKeyConfigured: state.apiKeyConfigured ?? true }),
    save: (next) => {
      saved.push(next)
      return Promise.resolve(next)
    },
  }
}

const 描く = (api: LlmApi = llmApi()) => render(<LlmPage api={api} />)

/** 設定が読み込まれて、入力欄が出るまで待つ */
const 読み込みを待つ = async () => {
  await waitFor(() => expect(screen.getByLabelText('チャットの文面の提供元')).toBeInTheDocument())
}

const 保存する = async () => userEvent.click(screen.getByRole('button', { name: '設定を保存' }))

describe('LlmPage', () => {
  test('AIを使う4か所ぶんの提供元とモデル名を出す', async () => {
    描く()
    await 読み込みを待つ()

    for (const 名前 of ['チャットの文面', 'サイドスーパー', '視聴者の人物像', '配信のあらすじ']) {
      expect(screen.getByLabelText(`${名前}の提供元`)).toHaveValue('workers-ai')
    }
    expect(screen.getByLabelText('チャットの文面のモデル')).toHaveValue('@cf/meta/llama-3.1-8b-instruct-fp8')
    expect(screen.getByLabelText('配信のあらすじのモデル')).toHaveValue('@cf/meta/llama-3.3-70b-instruct-fp8-fast')
  })

  test('提供元を切り替えると、その箇所だけがその提供元のモデル名に入れ替わる', async () => {
    描く()
    await 読み込みを待つ()

    await userEvent.selectOptions(screen.getByLabelText('配信のあらすじの提供元'), 'openrouter')

    expect(screen.getByLabelText('配信のあらすじのモデル')).toHaveValue('meta-llama/llama-3.3-70b-instruct')
    // ほかの箇所は変わらない
    expect(screen.getByLabelText('チャットの文面の提供元')).toHaveValue('workers-ai')
    expect(screen.getByLabelText('チャットの文面のモデル')).toHaveValue('@cf/meta/llama-3.1-8b-instruct-fp8')
  })

  test('提供元を切り替えて戻しても、前の提供元のモデル名は消えていない', async () => {
    描く()
    await 読み込みを待つ()

    await userEvent.selectOptions(screen.getByLabelText('視聴者の人物像の提供元'), 'openrouter')
    await userEvent.selectOptions(screen.getByLabelText('視聴者の人物像の提供元'), 'workers-ai')

    expect(screen.getByLabelText('視聴者の人物像のモデル')).toHaveValue('@cf/meta/llama-3.1-8b-instruct-fp8')
  })

  test('箇所ごとに提供元とモデル名を変えて保存すると、4か所ぶんをまとめて送る', async () => {
    const api = llmApi()
    描く(api)
    await 読み込みを待つ()

    await userEvent.selectOptions(screen.getByLabelText('配信のあらすじの提供元'), 'openrouter')
    await userEvent.clear(screen.getByLabelText('配信のあらすじのモデル'))
    await userEvent.type(screen.getByLabelText('配信のあらすじのモデル'), 'anthropic/claude-3.5-haiku')
    await 保存する()

    await waitFor(() =>
      expect(api.saved).toEqual([
        {
          usages: {
            ...保存済みの設定.usages,
            streamSummary: {
              provider: 'openrouter',
              models: { 'workers-ai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast', openrouter: 'anthropic/claude-3.5-haiku' },
            },
          },
        },
      ]),
    )
    expect(await screen.findByText('LLMの設定を保存しました')).toBeInTheDocument()
  })

  test('OpenRouter を選んでいる箇所があるのに鍵が設定されていなければ、設定の仕方を知らせる', async () => {
    描く(
      llmApi({
        settings: { usages: { ...保存済みの設定.usages, sideSuper: { provider: 'openrouter', models: { ...軽いモデル } } } },
        apiKeyConfigured: false,
      }),
    )
    await 読み込みを待つ()

    expect(await screen.findByRole('alert')).toHaveTextContent('OPENROUTER_API_KEY')
  })

  test('鍵が無くても、どこも Workers AI のままなら知らせない（要らない警告を出さないため）', async () => {
    描く(llmApi({ apiKeyConfigured: false }))
    await 読み込みを待つ()

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('切り替えた時点で鍵が無いと分かれば、保存する前に知らせる', async () => {
    描く(llmApi({ apiKeyConfigured: false }))
    await 読み込みを待つ()

    await userEvent.selectOptions(screen.getByLabelText('チャットの文面の提供元'), 'openrouter')

    expect(await screen.findByRole('alert')).toHaveTextContent('OPENROUTER_API_KEY')
  })

  test('Workerが返した問題点を、そのまま並べて出す（検証はWorkerだけが持つ）', async () => {
    const api = llmApi()
    描く({
      ...api,
      save: () =>
        Promise.reject(
          new ApiError(400, 'invalid-config', 'LLMの設定に問題があります', [
            'aiChat.models.openrouter: モデル名を200文字以内で指定してください',
          ]),
        ),
    })
    await 読み込みを待つ()

    await 保存する()

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('aiChat.models.openrouter: モデル名を200文字以内で指定してください'))
  })

  test('設定を読めなければ、黙って既定に倒さず理由を出す', async () => {
    描く({ load: () => Promise.reject(new Error('通信できませんでした')), save: () => Promise.reject(new Error('呼ばれない')) })

    expect(await screen.findByText('通信できませんでした')).toBeInTheDocument()
    expect(screen.queryByLabelText('チャットの文面の提供元')).not.toBeInTheDocument()
  })
})
