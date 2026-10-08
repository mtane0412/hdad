// @vitest-environment jsdom
/**
 * 下部バーのテキストの書き換え（text-bar.tsx）のテスト
 *
 * 確かめること:
 * - ボタンを押すと、テキストを読み込んで最初のテキストの本文を出し、選択欄で別のテキストに替えられること
 * - 本文を書き換えて保存すると Worker に書き換えてもらい、窓を閉じること（変えていないあいだは保存できない）
 * - テキストが無いときはページへの行き先を出すこと
 * - 読み込めない・拒まれたときは、黙らずに理由を出すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '@/core/api'
import type { TextApi, TextInput } from './api'
import type { TextEntry } from './entry'
import { TextBar } from './text-bar'

afterEach(cleanup)

const goal: TextEntry = { id: 1, name: '目標', body: 'ログイン画面を作り終える', updatedAt: '2026-10-08T12:00:00.000Z' }
const doing: TextEntry = { id: 3, name: '今やってること', body: 'テストを書いている', updatedAt: '2026-10-08T12:10:00.000Z' }

const createApi = (texts: TextEntry[] = [goal, doing], overrides: Partial<TextApi> = {}): TextApi => ({
  list: vi.fn(async () => texts),
  create: vi.fn(),
  update: vi.fn(async (id: number, input: TextInput) => ({ id, ...input, updatedAt: '2026-10-08T12:30:00.000Z' })),
  remove: vi.fn(),
  ...overrides,
})

/** 下部バーのボタンを押して、書き換えの窓を開く */
const openBar = async (): Promise<void> => {
  await userEvent.click(screen.getByRole('button', { name: 'テキストを書き換える' }))
}

describe('TextBar', () => {
  test('開くと最初のテキストの本文を出し、選択欄で別のテキストに替えられる', async () => {
    render(<TextBar api={createApi()} />)
    await openBar()

    const body = await screen.findByRole('textbox', { name: '本文' })
    expect(body).toHaveValue('ログイン画面を作り終える')

    await userEvent.selectOptions(screen.getByRole('combobox', { name: '書き換えるテキスト' }), '今やってること')

    expect(body).toHaveValue('テストを書いている')
  })

  test('本文を書き換えて保存すると、Workerに書き換えてもらい、窓を閉じる', async () => {
    const api = createApi()
    render(<TextBar api={api} />)
    await openBar()

    const body = await screen.findByRole('textbox', { name: '本文' })
    await userEvent.clear(body)
    await userEvent.type(body, 'ログイン画面をデプロイする')
    await userEvent.click(screen.getByRole('button', { name: '保存する' }))

    expect(api.update).toHaveBeenCalledWith(1, { name: '目標', body: 'ログイン画面をデプロイする' })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '本文' })).not.toBeInTheDocument())
  })

  test('変えていないあいだは保存できない', async () => {
    render(<TextBar api={createApi()} />)
    await openBar()

    await screen.findByRole('textbox', { name: '本文' })
    expect(screen.getByRole('button', { name: '保存する' })).toBeDisabled()
  })

  test('テキストが無ければ、テキストのページへの行き先を出す', async () => {
    render(<TextBar api={createApi([])} />)
    await openBar()

    expect(await screen.findByRole('link', { name: 'テキストのページ' })).toHaveAttribute('href', '/texts/')
  })

  test('読み込めなければ理由を出す', async () => {
    render(<TextBar api={createApi([], { list: vi.fn(async () => Promise.reject(new Error('Workerにつながりません'))) })} />)
    await openBar()

    expect(await screen.findByRole('alert')).toHaveTextContent('Workerにつながりません')
  })

  test('拒まれたら、窓を閉じずに理由を出す', async () => {
    const api = createApi([goal], {
      update: vi.fn(async () => Promise.reject(new ApiError(400, 'invalid-config', 'テキストに問題があります', ['body: 本文は4行以内にしてください（いまは5行です）']))),
    })
    render(<TextBar api={api} />)
    await openBar()

    await userEvent.type(await screen.findByRole('textbox', { name: '本文' }), '！')
    await userEvent.click(screen.getByRole('button', { name: '保存する' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('本文: 本文は4行以内にしてください（いまは5行です）')
    expect(screen.getByRole('textbox', { name: '本文' })).toBeInTheDocument()
  })
})
