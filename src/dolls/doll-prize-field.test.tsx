// @vitest-environment jsdom
/**
 * ゲームの正解者に渡す人形の選択欄（doll-prize-field.tsx）のテスト
 *
 * 確かめること（issue #420）:
 * - 保存してある人形（渡さない・ふつうの人形・スーパー人形）を選択欄に出すこと
 * - 選び直すと、保存ボタンを待たずにそのゲームの設定として保存し、保存したことを知らせること
 * - 読み込めなかった・保存できなかった理由を、黙らずに出すこと（保存できなければ選択欄は保存済みの値のまま）
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { DollApi } from './api'
import type { DollKind, DollPrizeGame } from './doll'
import { DollPrizeField } from './doll-prize-field'

afterEach(cleanup)

/** 正解者に渡す人形を読み書きする代役。保存は送られた種類をそのまま返す */
const createApi = (saved: DollKind | null, overrides: Partial<Pick<DollApi, 'prize' | 'savePrize'>> = {}) => ({
  prize: vi.fn(async () => saved),
  savePrize: vi.fn(async (_game: DollPrizeGame, kind: DollKind | null) => kind),
  ...overrides,
})

describe('正解者に渡す人形の選択欄', () => {
  test('保存してある人形を選択欄に出す', async () => {
    const api = createApi('super')

    render(<DollPrizeField api={api} game="kanjiQuiz" />)

    expect(await screen.findByRole('combobox', { name: '正解者に渡す人形' })).toHaveValue('super')
    expect(api.prize).toHaveBeenCalledWith('kanjiQuiz')
  })

  test('選び直すと、そのゲームの設定としてその場で保存し、保存したことを知らせる', async () => {
    // 前提: チャットで推理の正解者には、まだ人形を渡さない
    const api = createApi(null)
    render(<DollPrizeField api={api} game="chatDeduction" />)
    const select = await screen.findByRole('combobox', { name: '正解者に渡す人形' })
    expect(select).toHaveValue('none')

    await userEvent.selectOptions(select, 'ふつうの人形')

    expect(api.savePrize).toHaveBeenCalledWith('chatDeduction', 'normal')
    expect(await screen.findByText('正解者に渡す人形を保存しました')).toBeInTheDocument()
    expect(select).toHaveValue('normal')

    await userEvent.selectOptions(select, '渡さない')

    expect(api.savePrize).toHaveBeenLastCalledWith('chatDeduction', null)
    expect(select).toHaveValue('none')
  })

  test('保存できなければ理由を出し、選択欄は保存済みの人形のまま', async () => {
    const api = createApi('normal', {
      savePrize: vi.fn(async () => {
        throw new Error('Workerに届きませんでした')
      }),
    })
    render(<DollPrizeField api={api} game="kanjiQuiz" />)
    const select = await screen.findByRole('combobox', { name: '正解者に渡す人形' })

    await userEvent.selectOptions(select, 'スーパー人形')

    expect(await screen.findByText('Workerに届きませんでした')).toBeInTheDocument()
    expect(select).toHaveValue('normal')
  })

  test('読み込めなければ、渡さないことにせず理由を出す', async () => {
    const api = createApi(null, {
      prize: vi.fn(async () => {
        throw new Error('Workerの正解者に渡す人形の応答が想定した形ではありません')
      }),
    })

    render(<DollPrizeField api={api} game="kanjiQuiz" />)

    expect(await screen.findByText('Workerの正解者に渡す人形の応答が想定した形ではありません')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '正解者に渡す人形' })).not.toBeInTheDocument()
  })
})
