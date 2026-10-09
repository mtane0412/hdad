// @vitest-environment jsdom
/**
 * LLMのページのテスト
 *
 * 確かめること:
 * - AIを使う5か所ぶんの設定を読み込んで、表の1行ずつで提供元とモデルを選べること（モデルは入力ではなく選択）
 * - 箇所の説明は画面に並べず、ヘルプボタンを押したときだけ出すこと
 * - モデルの候補は提供元ごとにWorkerから読むこと。切り替えたら、その提供元の候補に入れ替わること
 * - 候補を読めなかったときは、黙って空の選択欄を出さず理由を出すこと
 * - 保存の応答を待っているあいだは選べなくすること（どの設定が保存されたかを取り違えないため）
 * - 箇所ごとに別の提供元を選んで保存できること（あらすじだけ OpenRouter にする使い方）
 * - 提供元ごとのモデル名を別々に持つこと（切り替えて戻しても前のモデル名が消えない）
 * - OpenRouter を選んでいる箇所があるのに鍵が設定されていなければ、その場で知らせること
 * - Workerが返した問題点を、そのまま画面に並べること（検証はWorkerだけが持つ）
 * - 設定を読めなかったときは、黙って既定に倒さず理由を出すこと
 * - 使用状況（今日・直近7日の呼び出し回数と失敗の回数）を、全体の合計と箇所の表の行ごとに出すこと
 * - 日ごとの呼び出し回数をグラフで出すこと
 * - 鍵が設定されているときだけ OpenRouter の残高を読み、出すこと
 * - 字幕の翻訳の提供元を選ぶ区画を、箇所の表の前に出すこと（区画そのものは translation-card.test.tsx で確かめる）
 * - 使用状況や残高を読めなくても設定の画面は出し、理由だけを添えること（モニターのために設定が触れなくならないようにする）
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '@/core/api'
import { LlmPage } from './llm-page'
import type { LlmApi, LlmCredits, LlmModelOption, LlmProvider, LlmSettings, LlmState, LlmUsageDay } from './api'

afterEach(cleanup)

beforeAll(() => {
  // jsdom には ResizeObserver がない。グラフが大きさを測るのに使うので、何もしない代役を置く
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  )
})

/**
 * 「今」として使う時刻（UTC）。
 *
 * 画面は描くときに Date.now() からUTCの今日を決めるので、テストが行に入れる日付と食い違わないよう時刻を固定する
 * （実時計のままだと、UTCの日付が変わる瞬間に描いた場合だけ落ちる）。時計だけを差し替え、待ち合わせ（waitFor・
 * userEvent）が使うタイマーは本物のままにする。
 */
const fixedNow = new Date('2026-03-15T12:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: fixedNow })
})

afterEach(() => {
  vi.useRealTimers()
})

/** 短い文を作る3か所の既定のモデル */
const lightModel = { 'workers-ai': '@cf/meta/llama-3.1-8b-instruct-fp8', openrouter: 'meta-llama/llama-3.1-8b-instruct' }
/** あらすじの既定のモデル */
const largeModel = { 'workers-ai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast', openrouter: 'meta-llama/llama-3.3-70b-instruct' }

/** 前提: Workerに保存されている、既定のままの設定（どこも Workers AI） */
const savedSettings: LlmSettings = {
  usages: {
    translation: { provider: 'workers-ai', models: { ...lightModel } },
    aiChat: { provider: 'workers-ai', models: { ...lightModel } },
    sideSuper: { provider: 'workers-ai', models: { ...lightModel } },
    viewerSummary: { provider: 'workers-ai', models: { ...lightModel } },
    streamSummary: { provider: 'workers-ai', models: { ...largeModel } },
    streamTitle: { provider: 'workers-ai', models: { ...largeModel } },
    townTour: { provider: 'workers-ai', models: { ...largeModel } },
    townBond: { provider: 'workers-ai', models: { ...largeModel } },
    autoText: { provider: 'workers-ai', models: { ...largeModel } },
  },
}

/** Workerが返すモデルの候補。提供元ごとに名前の付け方が違う */
const candidates: Readonly<Record<LlmProvider, LlmModelOption[]>> = {
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

/** 固定した現在時刻から見たUTCの今日と6日前（使用状況の行に使う。画面は「今日」「直近7日」に分けて数える） */
const today = fixedNow.toISOString().slice(0, 10)
const sixDaysAgo = new Date(fixedNow.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

/** 使用状況の1行を作る（書いていない項目は 0） */
const usageRow = (day: string, usage: string, addUsage: Partial<LlmUsageDay> = {}): LlmUsageDay => ({
  day,
  usage,
  provider: 'workers-ai',
  model: '@cf/meta/llama-3.1-8b-instruct-fp8',
  calls: 0,
  failures: 0,
  promptTokens: 0,
  completionTokens: 0,
  costUsd: 0,
  ...addUsage,
})

/** 画面に渡すもの。使用状況と残高は、渡さなければ空（まだ一度も呼んでいない状態）として答える */
interface pagePrerequisites extends Partial<LlmState> {
  usage?: LlmUsageDay[]
  credits?: LlmCredits
  /** 使用状況の読み出しを失敗させる */
  usageFailure?: Error
  /** 残高の読み出しを失敗させる */
  creditsFailure?: Error
}

/** 読み書きを記録する、LLMの設定のAPI */
const llmApi = (state: pagePrerequisites = {}): LlmApi & { saved: LlmSettings[]; balanceReadCount: () => number } => {
  const saved: LlmSettings[] = []
  let balanceCalls = 0
  return {
    saved,
    balanceReadCount: () => balanceCalls,
    load: () => Promise.resolve({ settings: state.settings ?? savedSettings, apiKeyConfigured: state.apiKeyConfigured ?? true }),
    save: (next) => {
      saved.push(next)
      return Promise.resolve(next)
    },
    listModels: (provider) => Promise.resolve(candidates[provider]),
    loadUsage: () => (state.usageFailure ? Promise.reject(state.usageFailure) : Promise.resolve(state.usage ?? [])),
    loadCredits: () => {
      balanceCalls += 1
      if (state.creditsFailure) return Promise.reject(state.creditsFailure)
      return Promise.resolve(state.credits ?? { totalCredits: 0, totalUsage: 0, remaining: 0 })
    },
    loadTranslation: () => Promise.resolve({ provider: 'llm', deeplKeyConfigured: false }),
    saveTranslation: (provider) => Promise.resolve(provider),
    loadDeeplUsage: () => Promise.reject(new Error('このテストでは DeepL の使用量を読みません')),
  }
}

const renderPage = (api: LlmApi = llmApi()) => render(<LlmPage api={api} />)

/** 設定が読み込まれて、入力欄が出るまで待つ */
const waitForLoad = async () => {
  await waitFor(() => expect(screen.getByLabelText('チャットの文面の提供元')).toBeInTheDocument())
}

/**
 * その箇所の選択欄に、提供元の候補が並ぶまで待つ。
 *
 * 候補はWorkerから非同期に読むので、入力欄が出た時点では、まだ保存済みの1件しか並んでいない。
 */
const waitForCandidates = async (optionName: string, provider: LlmProvider) => {
  await waitFor(() =>
    expect([...screen.getByLabelText(`${optionName}のモデル`).querySelectorAll('option')].map((option) => option.textContent)).toEqual(
      candidates[provider].map(({ name }) => name),
    ),
  )
}

/** 箇所の表から、その箇所の行を取り出す */
const usageRowOf = (name: string) => within(screen.getByRole('table', { name: 'AIを使う箇所' })).getByRole('row', { name })

const save = async () => userEvent.click(screen.getByRole('button', { name: '設定を保存' }))

describe('LlmPage', () => {
  test('AIを使う6か所ぶんの提供元とモデルを、表の1行ずつに選択欄として出す', async () => {
    renderPage()
    await waitForLoad()

    for (const optionName of ['字幕の翻訳（LLM）', 'チャットの文面', 'サイドスーパー', '視聴者の人物像', '配信のあらすじ', '市町村紹介']) {
      expect(within(usageRowOf(optionName)).getByLabelText(`${optionName}の提供元`)).toBeInTheDocument()
    }

    for (const optionName of ['チャットの文面', 'サイドスーパー', '視聴者の人物像', '配信のあらすじ']) {
      expect(screen.getByLabelText(`${optionName}の提供元`)).toHaveValue('workers-ai')
    }
    // モデルは入力欄ではなく選択欄で、Workerから読んだ候補が並ぶ
    const modelSelect = screen.getByLabelText('チャットの文面のモデル')
    expect(modelSelect.tagName).toBe('SELECT')
    expect(modelSelect).toHaveValue('@cf/meta/llama-3.1-8b-instruct-fp8')
    await waitForCandidates('チャットの文面', 'workers-ai')
    expect(screen.getByLabelText('配信のあらすじのモデル')).toHaveValue('@cf/meta/llama-3.3-70b-instruct-fp8-fast')
  })

  test('提供元を切り替えると、その箇所だけがその提供元のモデルと候補に入れ替わる', async () => {
    renderPage()
    await waitForLoad()

    await userEvent.selectOptions(screen.getByLabelText('配信のあらすじの提供元'), 'openrouter')

    await waitFor(() => expect(screen.getByLabelText('配信のあらすじのモデル')).toHaveValue('meta-llama/llama-3.3-70b-instruct'))
    await waitForCandidates('配信のあらすじ', 'openrouter')
    // ほかの箇所は変わらない
    expect(screen.getByLabelText('チャットの文面の提供元')).toHaveValue('workers-ai')
    expect(screen.getByLabelText('チャットの文面のモデル')).toHaveValue('@cf/meta/llama-3.1-8b-instruct-fp8')
  })

  test('提供元を切り替えて戻しても、前の提供元のモデル名は消えていない', async () => {
    renderPage()
    await waitForLoad()

    await userEvent.selectOptions(screen.getByLabelText('視聴者の人物像の提供元'), 'openrouter')
    await userEvent.selectOptions(screen.getByLabelText('視聴者の人物像の提供元'), 'workers-ai')

    await waitFor(() => expect(screen.getByLabelText('視聴者の人物像のモデル')).toHaveValue('@cf/meta/llama-3.1-8b-instruct-fp8'))
  })

  test('箇所ごとに提供元とモデル名を変えて保存すると、4か所ぶんをまとめて送る', async () => {
    const api = llmApi()
    renderPage(api)
    await waitForLoad()

    await userEvent.selectOptions(screen.getByLabelText('配信のあらすじの提供元'), 'openrouter')
    await waitFor(() => expect(screen.getByLabelText('配信のあらすじのモデル')).toHaveValue('meta-llama/llama-3.3-70b-instruct'))
    await userEvent.selectOptions(screen.getByLabelText('配信のあらすじのモデル'), 'anthropic/claude-3.5-haiku')
    await save()

    await waitFor(() =>
      expect(api.saved).toEqual([
        {
          usages: {
            ...savedSettings.usages,
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

  test('保存の応答を待っているあいだは、提供元もモデルも選べなくする（どの設定が保存されたかを取り違えないため）', async () => {
    let finishSave: (settings: LlmSettings) => void = () => {}
    renderPage({
      ...llmApi(),
      save: (next) => new Promise<LlmSettings>((resolve) => (finishSave = () => resolve(next))),
    })
    await waitForLoad()
    // 候補が並ぶ前はモデルの選択欄が読み込み中で無効なので、並んでから保存する
    await waitForCandidates('サイドスーパー', 'workers-ai')

    await save()

    expect(screen.getByLabelText('サイドスーパーの提供元')).toBeDisabled()
    expect(screen.getByLabelText('サイドスーパーのモデル')).toBeDisabled()

    finishSave(savedSettings)

    await waitFor(() => expect(screen.getByText('LLMの設定を保存しました')).toBeInTheDocument())
    // 保存が終われば、また選べる
    expect(screen.getByLabelText('サイドスーパーの提供元')).not.toBeDisabled()
    expect(screen.getByLabelText('サイドスーパーのモデル')).not.toBeDisabled()
  })

  test('OpenRouter を選んでいる箇所があるのに鍵が設定されていなければ、設定の仕方を知らせる', async () => {
    renderPage(
      llmApi({
        settings: { usages: { ...savedSettings.usages, sideSuper: { provider: 'openrouter', models: { ...lightModel } } } },
        apiKeyConfigured: false,
      }),
    )
    await waitForLoad()

    expect(await screen.findByRole('alert')).toHaveTextContent('OPENROUTER_API_KEY')
  })

  test('鍵が無くても、どこも Workers AI のままなら知らせない（要らない警告を出さないため）', async () => {
    renderPage(llmApi({ apiKeyConfigured: false }))
    await waitForLoad()

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('切り替えた時点で鍵が無いと分かれば、保存する前に知らせる', async () => {
    renderPage(llmApi({ apiKeyConfigured: false }))
    await waitForLoad()

    await userEvent.selectOptions(screen.getByLabelText('チャットの文面の提供元'), 'openrouter')

    expect(await screen.findByRole('alert')).toHaveTextContent('OPENROUTER_API_KEY')
  })

  test('Workerが返した問題点を、そのまま並べて出す（検証はWorkerだけが持つ）', async () => {
    const api = llmApi()
    renderPage({
      ...api,
      save: () =>
        Promise.reject(
          new ApiError(400, 'invalid-config', 'LLMの設定に問題があります', [
            'aiChat.models.openrouter: モデル名を200文字以内で指定してください',
          ]),
        ),
    })
    await waitForLoad()

    await save()

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('aiChat.models.openrouter: モデル名を200文字以内で指定してください'))
  })

  test('モデルの候補を読めなければ、黙って空の選択欄を出さず理由を出す', async () => {
    renderPage({ ...llmApi(), listModels: () => Promise.reject(new Error('OpenRouter のモデルの一覧を取れませんでした（503）')) })
    await waitForLoad()

    expect(await screen.findByRole('alert')).toHaveTextContent('OpenRouter のモデルの一覧を取れませんでした（503）')
  })

  test('保存済みのモデルが候補に無ければ、それも選べる形で残す（勝手に別のモデルへ移さない）', async () => {
    renderPage(
      llmApi({
        settings: {
          usages: {
            ...savedSettings.usages,
            sideSuper: { provider: 'workers-ai', models: { ...lightModel, 'workers-ai': '@cf/meta/一覧から消えたモデル' } },
          },
        },
      }),
    )
    await waitForLoad()

    await waitFor(() => expect(screen.getByLabelText('サイドスーパーのモデル')).toHaveValue('@cf/meta/一覧から消えたモデル'))
  })

  test('箇所の説明は画面に並べず、ヘルプボタンを押したときだけ出す', async () => {
    renderPage()
    await waitForLoad()
    expect(screen.queryByText(/発言ごとに呼ばれる/)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'チャットの文面の説明' }))

    expect(await screen.findByText(/発言ごとに呼ばれる/)).toBeInTheDocument()
  })

  test('設定を読めなければ、黙って既定に倒さず理由を出す', async () => {
    renderPage({
      load: () => Promise.reject(new Error('通信できませんでした')),
      save: () => Promise.reject(new Error('呼ばれない')),
      listModels: () => Promise.resolve(candidates['workers-ai']),
      loadUsage: () => Promise.resolve([]),
      loadCredits: () => Promise.reject(new Error('呼ばれない')),
      loadTranslation: () => Promise.resolve({ provider: 'off', deeplKeyConfigured: false }),
      saveTranslation: () => Promise.reject(new Error('呼ばれない')),
      loadDeeplUsage: () => Promise.reject(new Error('呼ばれない')),
    })

    expect(await screen.findByText('通信できませんでした')).toBeInTheDocument()
    expect(screen.queryByLabelText('チャットの文面の提供元')).not.toBeInTheDocument()
  })
})

describe('使用状況', () => {
  test('全体の合計と、箇所の表の行ごとに、今日と直近7日の呼び出し回数・失敗の回数・トークン数を出す', async () => {
    const api = llmApi({
      usage: [
        usageRow(today, 'aiChat', { calls: 12, failures: 1, promptTokens: 9_000, completionTokens: 3_000 }),
        usageRow(sixDaysAgo, 'aiChat', { calls: 30, promptTokens: 20_000, completionTokens: 5_000 }),
      ],
    })
    renderPage(api)
    await waitForLoad()

    // 全体の合計（ほかの箇所は呼んでいないので、チャットの文面と同じ数になる）
    await waitFor(() => expect(screen.getByRole('group', { name: '今日' })).toHaveTextContent('12回（失敗1回）'))
    expect(screen.getByRole('group', { name: '今日' })).toHaveTextContent('12,000トークン')
    expect(screen.getByRole('group', { name: '直近7日' })).toHaveTextContent('42回（失敗1回）')
    expect(screen.getByRole('group', { name: '直近7日' })).toHaveTextContent('37,000トークン')
    // 箇所の行
    expect(usageRowOf('チャットの文面')).toHaveTextContent('12回（失敗1回）')
    expect(usageRowOf('チャットの文面')).toHaveTextContent('42回（失敗1回）')
    expect(usageRowOf('サイドスーパー')).toHaveTextContent('0回')
  })

  test('直近7日の実費（OpenRouter のぶん）を出す', async () => {
    renderPage(llmApi({ usage: [usageRow(today, 'streamSummary', { calls: 1, provider: 'openrouter', costUsd: 0.0123 })] }))
    await waitForLoad()

    await waitFor(() => expect(screen.getByRole('group', { name: '直近7日の実費' })).toHaveTextContent('$0.0123'))
  })

  test('判定用のモデル Jev の箇所（BGMの選択）も表に並べる（選ぶモデルは無いので、選択欄は出さない）', async () => {
    renderPage(llmApi({ usage: [usageRow(today, 'bgm', { calls: 3, promptTokens: 3_000, completionTokens: 30 })] }))
    await waitForLoad()

    await waitFor(() => expect(usageRowOf('BGMの選択（Jev）')).toHaveTextContent('3回'))
    expect(usageRowOf('BGMの選択（Jev）')).toHaveTextContent('3,030トークン')
    expect(within(usageRowOf('BGMの選択（Jev）')).queryByRole('combobox')).not.toBeInTheDocument()
  })

  test('日ごとの呼び出し回数をグラフで出す', async () => {
    renderPage()
    await waitForLoad()

    // グラフ（Recharts）は React.lazy で切り離してあるので、出るまで待つ
    expect(await screen.findByRole('img', { name: '直近30日の呼び出し回数の推移' })).toBeInTheDocument()
  })

  test('鍵が設定されていれば OpenRouter の残高を出す', async () => {
    renderPage(llmApi({ apiKeyConfigured: true, credits: { totalCredits: 10, totalUsage: 2.5, remaining: 7.5 } }))
    await waitForLoad()

    await waitFor(() => expect(screen.getByRole('group', { name: 'OpenRouter の残高' })).toHaveTextContent('$7.50'))
    expect(screen.getByRole('group', { name: 'OpenRouter の残高' })).toHaveTextContent('付与 $10.00')
  })

  test('鍵が設定されていなければ、残高は読みに行かない', async () => {
    const api = llmApi({ apiKeyConfigured: false })
    renderPage(api)
    await waitForLoad()

    await waitFor(() => expect(screen.getByRole('group', { name: '今日' })).toHaveTextContent('0回'))
    expect(api.balanceReadCount()).toBe(0)
    expect(screen.queryByRole('group', { name: 'OpenRouter の残高' })).not.toBeInTheDocument()
  })

  test('使用状況を読めなくても設定は触れるようにし、理由だけを添える', async () => {
    renderPage(llmApi({ usageFailure: new Error('Workerの /api/admin/llm/usage を呼び出せませんでした') }))
    await waitForLoad()

    await waitFor(() => expect(screen.getByText(/\/api\/admin\/llm\/usage/)).toBeInTheDocument())
    // 設定の選択欄はそのまま使える
    expect(screen.getByLabelText('チャットの文面のモデル')).toBeEnabled()
  })

  test('残高を読めなくても、使用状況と設定はそのまま出す', async () => {
    renderPage(llmApi({ apiKeyConfigured: true, creditsFailure: new Error('OpenRouter の残高を取れませんでした（401）') }))
    await waitForLoad()

    await waitFor(() => expect(screen.getByText(/残高を取れませんでした/)).toBeInTheDocument())
    expect(screen.getByRole('group', { name: '今日' })).toHaveTextContent('0回')
  })

  test('字幕の翻訳の提供元を選ぶ区画を出す', async () => {
    renderPage()

    expect(await screen.findByLabelText('字幕の翻訳の提供元')).toHaveValue('llm')
  })
})
