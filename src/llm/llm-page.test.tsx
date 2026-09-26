// @vitest-environment jsdom
/**
 * LLMのページのテスト
 *
 * 確かめること:
 * - 保存済みの設定を読み込んで入力欄に出し、提供元とモデル名を変えて保存できること
 * - 提供元ごとのモデル名を別々に持つこと（切り替えて戻しても前のモデル名が消えない）
 * - OpenRouter を選んでいるのに鍵が設定されていなければ、その場で知らせること
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

/** 前提: Workerに保存されている、既定のままの設定（Workers AI） */
const 保存済みの設定: LlmSettings = {
  provider: 'workers-ai',
  workersAi: { chat: '@cf/meta/llama-3.1-8b-instruct-fp8', summary: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
  openrouter: { chat: 'meta-llama/llama-3.1-8b-instruct', summary: 'meta-llama/llama-3.3-70b-instruct' },
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
  await waitFor(() => expect(screen.getByLabelText('提供元')).toBeInTheDocument())
}

const 保存する = async () => userEvent.click(screen.getByRole('button', { name: '設定を保存' }))

describe('LlmPage', () => {
  test('保存済みの設定を入力欄に出す', async () => {
    描く()
    await 読み込みを待つ()

    expect(screen.getByLabelText('提供元')).toHaveValue('workers-ai')
    expect(screen.getByLabelText('チャットの文面・サイドスーパー・人物像のモデル')).toHaveValue('@cf/meta/llama-3.1-8b-instruct-fp8')
    expect(screen.getByLabelText('配信のあらすじのモデル')).toHaveValue('@cf/meta/llama-3.3-70b-instruct-fp8-fast')
  })

  test('提供元を切り替えると、その提供元のモデル名に入れ替わる（両方を持っているため）', async () => {
    描く()
    await 読み込みを待つ()

    await userEvent.selectOptions(screen.getByLabelText('提供元'), 'openrouter')

    expect(screen.getByLabelText('チャットの文面・サイドスーパー・人物像のモデル')).toHaveValue('meta-llama/llama-3.1-8b-instruct')

    // 戻しても、Workers AI 側のモデル名は消えていない
    await userEvent.selectOptions(screen.getByLabelText('提供元'), 'workers-ai')
    expect(screen.getByLabelText('チャットの文面・サイドスーパー・人物像のモデル')).toHaveValue('@cf/meta/llama-3.1-8b-instruct-fp8')
  })

  test('提供元とモデル名を変えて保存すると、両方の提供元のモデル名を添えて送る', async () => {
    const api = llmApi()
    描く(api)
    await 読み込みを待つ()

    await userEvent.selectOptions(screen.getByLabelText('提供元'), 'openrouter')
    await userEvent.clear(screen.getByLabelText('配信のあらすじのモデル'))
    await userEvent.type(screen.getByLabelText('配信のあらすじのモデル'), 'anthropic/claude-3.5-haiku')
    await 保存する()

    await waitFor(() =>
      expect(api.saved).toEqual([
        {
          provider: 'openrouter',
          workersAi: 保存済みの設定.workersAi,
          openrouter: { chat: 'meta-llama/llama-3.1-8b-instruct', summary: 'anthropic/claude-3.5-haiku' },
        },
      ]),
    )
    expect(await screen.findByText('LLMの設定を保存しました')).toBeInTheDocument()
  })

  test('OpenRouter を選んでいるのに鍵が設定されていなければ、設定の仕方を知らせる', async () => {
    描く(llmApi({ settings: { ...保存済みの設定, provider: 'openrouter' }, apiKeyConfigured: false }))
    await 読み込みを待つ()

    expect(await screen.findByRole('alert')).toHaveTextContent('OPENROUTER_API_KEY')
  })

  test('鍵が無くても、Workers AI を選んでいるあいだは知らせない（要らない警告を出さないため）', async () => {
    描く(llmApi({ apiKeyConfigured: false }))
    await 読み込みを待つ()

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('切り替えた時点で鍵が無いと分かれば、保存する前に知らせる', async () => {
    描く(llmApi({ apiKeyConfigured: false }))
    await 読み込みを待つ()

    await userEvent.selectOptions(screen.getByLabelText('提供元'), 'openrouter')

    expect(await screen.findByRole('alert')).toHaveTextContent('OPENROUTER_API_KEY')
  })

  test('Workerが返した問題点を、そのまま並べて出す（検証はWorkerだけが持つ）', async () => {
    const api = llmApi()
    描く({
      ...api,
      save: () =>
        Promise.reject(
          new ApiError(400, 'invalid-config', 'LLMの設定に問題があります', ['openrouter.chat: モデル名を200文字以内で指定してください']),
        ),
    })
    await 読み込みを待つ()

    await 保存する()

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('openrouter.chat: モデル名を200文字以内で指定してください'))
  })

  test('設定を読めなければ、黙って既定に倒さず理由を出す', async () => {
    描く({ load: () => Promise.reject(new Error('通信できませんでした')), save: () => Promise.reject(new Error('呼ばれない')) })

    expect(await screen.findByText('通信できませんでした')).toBeInTheDocument()
    expect(screen.queryByLabelText('提供元')).not.toBeInTheDocument()
  })
})
