// @vitest-environment jsdom
/**
 * LLMのページで、グラフの読み込みに失敗したときのテスト
 *
 * グラフ（usage-chart.tsx）は React.lazy で切り離して読み込むので、デプロイの直後などに読み込みが失敗しうる。
 * 確かめること:
 * - グラフの場所にだけ理由を出し、設定の選択欄と保存ボタンはそのまま使えること
 *
 * 注意: グラフの読み込みを失敗させるために usage-chart.tsx をファイルごと差し替えるので、ほかのテストとは
 * ファイルを分けてある。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { LlmPage } from './llm-page'
import type { LlmApi } from './api'

vi.mock('./usage-chart', () => {
  throw new Error('グラフのファイルを読み込めませんでした')
})

afterEach(cleanup)

/** 前提: どこも Workers AI のままの、保存済みの設定 */
const lightModel = { 'workers-ai': '@cf/meta/llama-3.1-8b-instruct-fp8', openrouter: 'meta-llama/llama-3.1-8b-instruct' }

const api: LlmApi = {
  load: () =>
    Promise.resolve({
      settings: {
        usages: {
          translation: { provider: 'workers-ai', models: { ...lightModel } },
          aiChat: { provider: 'workers-ai', models: { ...lightModel } },
          sideSuper: { provider: 'workers-ai', models: { ...lightModel } },
          viewerSummary: { provider: 'workers-ai', models: { ...lightModel } },
          streamSummary: { provider: 'workers-ai', models: { ...lightModel } },
          streamTitle: { provider: 'workers-ai', models: { ...lightModel } },
          townTour: { provider: 'workers-ai', models: { ...lightModel } },
        },
      },
      apiKeyConfigured: false,
    }),
  save: (next) => Promise.resolve(next),
  listModels: () => Promise.resolve([{ id: lightModel['workers-ai'], name: 'Llama 3.1 8B Instruct（fp8）' }]),
  loadUsage: () => Promise.resolve([]),
  loadCredits: () => Promise.reject(new Error('呼ばれない')),
  loadTranslation: () => Promise.resolve({ provider: 'off', deeplKeyConfigured: false }),
  saveTranslation: (provider) => Promise.resolve(provider),
  loadDeeplUsage: () => Promise.reject(new Error('呼ばれない')),
}

describe('グラフの読み込みに失敗したとき', () => {
  test('グラフの場所にだけ理由を出し、設定はそのまま触れる', async () => {
    render(<LlmPage api={api} />)

    expect(await screen.findByText(/グラフを読み込めませんでした/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('チャットの文面のモデル')).toBeEnabled())
    expect(screen.getByRole('button', { name: '設定を保存' })).toBeEnabled()
  })
})
