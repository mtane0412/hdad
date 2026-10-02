// @vitest-environment jsdom
/**
 * 字幕の翻訳の区画（translation-card.tsx）のテスト
 *
 * /llm/ のページに置く、確定した発話をどの提供元で英訳するかを選ぶ区画である（issue #191）。
 * 確かめること:
 * - 保存済みの提供元を選択欄に出し、選び直して保存できること
 * - DeepL を選んでいるのに鍵が無ければ、その場で知らせること
 * - DeepL の鍵があれば今月の使用量（無料枠の残り）を出し、読めなければ理由を出すこと
 * - 設定を読めなかったときは、黙って「訳さない」に倒さず理由を出すこと
 * - 選び直して保存していないあいだは、ページを離れる前に確認を出すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test } from 'vitest'
import type { DeeplUsage, TranslationProvider, TranslationState } from './api'
import { TranslationCard, type TranslationCardApi } from './translation-card'

afterEach(cleanup)

/** 画面に渡すもの */
interface Prerequisites {
  state?: TranslationState
  loadFailure?: Error
  deeplUsage?: DeeplUsage
  deeplUsageFailure?: Error
}

/** 読み書きを記録する、翻訳の設定のAPI */
const translationApi = (prerequisites: Prerequisites = {}): TranslationCardApi & { saved: TranslationProvider[]; deeplUsageReads: () => number } => {
  const saved: TranslationProvider[] = []
  let deeplUsageReads = 0
  return {
    saved,
    deeplUsageReads: () => deeplUsageReads,
    loadTranslation: () =>
      prerequisites.loadFailure
        ? Promise.reject(prerequisites.loadFailure)
        : Promise.resolve(prerequisites.state ?? { provider: 'off', deeplKeyConfigured: false }),
    saveTranslation: (provider) => {
      saved.push(provider)
      return Promise.resolve(provider)
    },
    loadDeeplUsage: () => {
      deeplUsageReads += 1
      if (prerequisites.deeplUsageFailure) return Promise.reject(prerequisites.deeplUsageFailure)
      return Promise.resolve(prerequisites.deeplUsage ?? { characterCount: 0, characterLimit: 500_000 })
    },
  }
}

/** ページを離れようとしたとき、確認を出す（既定の動作が止められる）かどうか */
const blocksUnload = (): boolean => {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

const providerSelect = () => screen.findByLabelText('字幕の翻訳の提供元')

describe('TranslationCard', () => {
  test('保存済みの提供元を出し、選び直して保存できる', async () => {
    const api = translationApi()
    render(<TranslationCard api={api} />)

    expect(await providerSelect()).toHaveValue('off')
    await userEvent.selectOptions(await providerSelect(), 'm2m100')
    await userEvent.click(screen.getByRole('button', { name: '翻訳の設定を保存' }))

    await waitFor(() => expect(api.saved).toEqual(['m2m100']))
    expect(await screen.findByText('字幕の翻訳の設定を保存しました')).toBeInTheDocument()
  })

  test('DeepL を選んでいるのに鍵が無ければ、その場で知らせる（使用量は読みに行かない）', async () => {
    const api = translationApi()
    render(<TranslationCard api={api} />)

    await userEvent.selectOptions(await providerSelect(), 'deepl')

    expect(screen.getByText('DeepL のAPIキーが設定されていません')).toBeInTheDocument()
    expect(api.deeplUsageReads()).toBe(0)
  })

  test('DeepL の鍵があれば、今月の使用量と残りを出す', async () => {
    render(
      <TranslationCard
        api={translationApi({ state: { provider: 'deepl', deeplKeyConfigured: true }, deeplUsage: { characterCount: 120_000, characterLimit: 500_000 } })}
      />,
    )

    expect(await screen.findByText('今月 120,000 / 500,000字（残り 380,000字）')).toBeInTheDocument()
  })

  test('DeepL の使用量を読めなければ、理由を出す（設定はそのまま選べる）', async () => {
    render(
      <TranslationCard
        api={translationApi({ state: { provider: 'deepl', deeplKeyConfigured: true }, deeplUsageFailure: new Error('DeepL が失敗を返しました（403）') })}
      />,
    )

    expect(await screen.findByText('DeepL が失敗を返しました（403）')).toBeInTheDocument()
    expect(await providerSelect()).toHaveValue('deepl')
  })

  test('設定を読めなければ、黙って「訳さない」に倒さず理由を出す', async () => {
    render(<TranslationCard api={translationApi({ loadFailure: new Error('KVを読めませんでした') })} />)

    expect(await screen.findByText('KVを読めませんでした')).toBeInTheDocument()
    expect(screen.queryByLabelText('字幕の翻訳の提供元')).not.toBeInTheDocument()
  })

  test('選び直して保存していないあいだは、ページを離れる前に確認を出す', async () => {
    render(<TranslationCard api={translationApi()} />)

    await userEvent.selectOptions(await providerSelect(), 'deepl')
    expect(blocksUnload()).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: '翻訳の設定を保存' }))
    await screen.findByText('字幕の翻訳の設定を保存しました')
    expect(blocksUnload()).toBe(false)
  })
})
