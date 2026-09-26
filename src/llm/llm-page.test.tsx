// @vitest-environment jsdom
/**
 * LLMのページのテスト
 *
 * 確かめること:
 * - AIを使う4か所ぶんの設定を読み込んで、箇所ごとに提供元とモデルを選べること（モデルは入力ではなく選択）
 * - モデルの候補は提供元ごとにWorkerから読むこと。切り替えたら、その提供元の候補に入れ替わること
 * - 候補を読めなかったときは、黙って空の選択欄を出さず理由を出すこと
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
import type { LlmApi, LlmModelOption, LlmProvider, LlmSettings, LlmState } from './api'

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

/** Workerが返すモデルの候補。提供元ごとに名前の付け方が違う */
const 候補: Readonly<Record<LlmProvider, LlmModelOption[]>> = {
  'workers-ai': [
    { id: '@cf/meta/llama-3.1-8b-instruct-fp8', name: 'Llama 3.1 8B Instruct（fp8）' },
    { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 3.3 70B Instruct（fp8・高速）' },
  ],
  openrouter: [
    { id: 'anthropic/claude-3.5-haiku', name: 'Anthropic: Claude 3.5 Haiku' },
    { id: 'meta-llama/llama-3.1-8b-instruct', name: 'Meta: Llama 3.1 8B Instruct' },
    { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Meta: Llama 3.3 70B Instruct' },
  ],
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
    listModels: (provider) => Promise.resolve(候補[provider]),
  }
}

const 描く = (api: LlmApi = llmApi()) => render(<LlmPage api={api} />)

/** 設定が読み込まれて、入力欄が出るまで待つ */
const 読み込みを待つ = async () => {
  await waitFor(() => expect(screen.getByLabelText('チャットの文面の提供元')).toBeInTheDocument())
}

const 保存する = async () => userEvent.click(screen.getByRole('button', { name: '設定を保存' }))

describe('LlmPage', () => {
  test('AIを使う4か所ぶんの提供元とモデルを、選択欄として出す', async () => {
    描く()
    await 読み込みを待つ()

    for (const 名前 of ['チャットの文面', 'サイドスーパー', '視聴者の人物像', '配信のあらすじ']) {
      expect(screen.getByLabelText(`${名前}の提供元`)).toHaveValue('workers-ai')
    }
    // モデルは入力欄ではなく選択欄で、Workerから読んだ候補が並ぶ
    const モデルの選択欄 = await screen.findByLabelText('チャットの文面のモデル')
    expect(モデルの選択欄.tagName).toBe('SELECT')
    expect(モデルの選択欄).toHaveValue('@cf/meta/llama-3.1-8b-instruct-fp8')
    expect([...モデルの選択欄.querySelectorAll('option')].map((option) => option.textContent)).toEqual(
      候補['workers-ai'].map(({ name }) => name),
    )
    expect(await screen.findByLabelText('配信のあらすじのモデル')).toHaveValue('@cf/meta/llama-3.3-70b-instruct-fp8-fast')
  })

  test('提供元を切り替えると、その箇所だけがその提供元のモデルと候補に入れ替わる', async () => {
    描く()
    await 読み込みを待つ()

    await userEvent.selectOptions(screen.getByLabelText('配信のあらすじの提供元'), 'openrouter')

    await waitFor(() => expect(screen.getByLabelText('配信のあらすじのモデル')).toHaveValue('meta-llama/llama-3.3-70b-instruct'))
    expect([...screen.getByLabelText('配信のあらすじのモデル').querySelectorAll('option')].map((option) => option.textContent)).toEqual(
      候補.openrouter.map(({ name }) => name),
    )
    // ほかの箇所は変わらない
    expect(screen.getByLabelText('チャットの文面の提供元')).toHaveValue('workers-ai')
    expect(screen.getByLabelText('チャットの文面のモデル')).toHaveValue('@cf/meta/llama-3.1-8b-instruct-fp8')
  })

  test('提供元を切り替えて戻しても、前の提供元のモデル名は消えていない', async () => {
    描く()
    await 読み込みを待つ()

    await userEvent.selectOptions(screen.getByLabelText('視聴者の人物像の提供元'), 'openrouter')
    await userEvent.selectOptions(screen.getByLabelText('視聴者の人物像の提供元'), 'workers-ai')

    await waitFor(() => expect(screen.getByLabelText('視聴者の人物像のモデル')).toHaveValue('@cf/meta/llama-3.1-8b-instruct-fp8'))
  })

  test('箇所ごとに提供元とモデル名を変えて保存すると、4か所ぶんをまとめて送る', async () => {
    const api = llmApi()
    描く(api)
    await 読み込みを待つ()

    await userEvent.selectOptions(screen.getByLabelText('配信のあらすじの提供元'), 'openrouter')
    await waitFor(() => expect(screen.getByLabelText('配信のあらすじのモデル')).toHaveValue('meta-llama/llama-3.3-70b-instruct'))
    await userEvent.selectOptions(screen.getByLabelText('配信のあらすじのモデル'), 'anthropic/claude-3.5-haiku')
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

  test('保存の応答を待っているあいだに変えた設定を、応答で巻き戻さない', async () => {
    let 保存を終える: (settings: LlmSettings) => void = () => {}
    描く({
      ...llmApi(),
      save: (next) => new Promise<LlmSettings>((resolve) => (保存を終える = () => resolve(next))),
    })
    await 読み込みを待つ()

    await 保存する()
    // 応答が返る前に、別の箇所の提供元を変える
    await userEvent.selectOptions(screen.getByLabelText('サイドスーパーの提供元'), 'openrouter')
    保存を終える(保存済みの設定)

    await waitFor(() => expect(screen.getByText('LLMの設定を保存しました')).toBeInTheDocument())
    expect(screen.getByLabelText('サイドスーパーの提供元')).toHaveValue('openrouter')
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

  test('モデルの候補を読めなければ、黙って空の選択欄を出さず理由を出す', async () => {
    描く({ ...llmApi(), listModels: () => Promise.reject(new Error('OpenRouter のモデルの一覧を取れませんでした（503）')) })
    await 読み込みを待つ()

    expect(await screen.findByRole('alert')).toHaveTextContent('OpenRouter のモデルの一覧を取れませんでした（503）')
  })

  test('保存済みのモデルが候補に無ければ、それも選べる形で残す（勝手に別のモデルへ移さない）', async () => {
    描く(
      llmApi({
        settings: {
          usages: {
            ...保存済みの設定.usages,
            sideSuper: { provider: 'workers-ai', models: { ...軽いモデル, 'workers-ai': '@cf/meta/一覧から消えたモデル' } },
          },
        },
      }),
    )
    await 読み込みを待つ()

    await waitFor(() => expect(screen.getByLabelText('サイドスーパーのモデル')).toHaveValue('@cf/meta/一覧から消えたモデル'))
  })

  test('設定を読めなければ、黙って既定に倒さず理由を出す', async () => {
    描く({
      load: () => Promise.reject(new Error('通信できませんでした')),
      save: () => Promise.reject(new Error('呼ばれない')),
      listModels: () => Promise.resolve(候補['workers-ai']),
    })

    expect(await screen.findByText('通信できませんでした')).toBeInTheDocument()
    expect(screen.queryByLabelText('チャットの文面の提供元')).not.toBeInTheDocument()
  })
})
