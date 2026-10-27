// @vitest-environment jsdom
/**
 * 漢字クイズで配信を止めるまでの時間切れの回数の選択欄（kanji-quiz-miss-limit-field.tsx）のテスト
 *
 * 確かめること:
 * - 保存してある回数を選択欄に出すこと
 * - 選び直すと、保存ボタンを待たずにその場で保存し、保存したことを知らせること
 * - 読み込めなかった・保存できなかった理由を、黙らずに出すこと（保存できなければ選択欄は保存済みの値のまま）
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { KanjiQuizMissLimitField, type KanjiQuizMissLimitApi } from './kanji-quiz-miss-limit-field'

afterEach(cleanup)

const LABEL = '配信を終える時間切れの回数（1配信あたり）'

/** 回数を読み書きする代役。保存は送られた回数をそのまま返す */
const createApi = (saved: number, overrides: Partial<KanjiQuizMissLimitApi> = {}): KanjiQuizMissLimitApi => ({
  kanjiQuizMissLimit: vi.fn(async () => saved),
  saveKanjiQuizMissLimit: vi.fn(async (missLimit: number) => missLimit),
  ...overrides,
})

describe('配信を止めるまでの時間切れの回数の選択欄', () => {
  test('保存してある回数を選択欄に出す', async () => {
    render(<KanjiQuizMissLimitField api={createApi(3)} />)

    expect(await screen.findByRole('combobox', { name: LABEL })).toHaveValue('3')
  })

  test('選び直すと、その場で保存し、保存したことを知らせる', async () => {
    // 前提: まだ1回の時間切れで配信を止める
    const api = createApi(1)
    render(<KanjiQuizMissLimitField api={api} />)
    const select = await screen.findByRole('combobox', { name: LABEL })

    await userEvent.selectOptions(select, '3回')

    expect(api.saveKanjiQuizMissLimit).toHaveBeenCalledWith(3)
    expect(await screen.findByText('配信を終える時間切れの回数を保存しました')).toBeInTheDocument()
    expect(select).toHaveValue('3')
  })

  test('保存できなければ理由を出し、選択欄は保存済みの回数のまま', async () => {
    const api = createApi(2, {
      saveKanjiQuizMissLimit: vi.fn(async () => {
        throw new Error('Workerに届きませんでした')
      }),
    })
    render(<KanjiQuizMissLimitField api={api} />)
    const select = await screen.findByRole('combobox', { name: LABEL })

    await userEvent.selectOptions(select, '5回')

    expect(await screen.findByText('Workerに届きませんでした')).toBeInTheDocument()
    expect(select).toHaveValue('2')
  })

  test('読み込めなければ、1回とみなさずに理由を出す', async () => {
    const api = createApi(1, {
      kanjiQuizMissLimit: vi.fn(async () => {
        throw new Error('配信を止めるまでの時間切れの回数は 1〜10 の整数のはずです')
      }),
    })

    render(<KanjiQuizMissLimitField api={api} />)

    expect(await screen.findByText('配信を止めるまでの時間切れの回数は 1〜10 の整数のはずです')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: LABEL })).not.toBeInTheDocument()
  })
})
