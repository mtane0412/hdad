// @vitest-environment jsdom
/**
 * テキストのページ（/texts/）のテスト
 *
 * 確かめること:
 * - 保存済みのテキストを、名前と本文の入力欄で1件ずつ出すこと
 * - 本文を書き換えて保存すると Worker に書き換えてもらい、変えていないあいだは保存できないこと
 * - テキストを追加・削除できること（削除は確かめてから行う）
 * - Worker が拒んだ理由（問題点）と、読み込めなかった理由を黙らずに出すこと
 * - 保存していない変更があるあいだは、ページを離れる前に確認を出すこと（useUnsavedChanges）
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { hasUnsavedChanges } from '@/app/router'
import { ApiError } from '@/core/api'
import type { TextApi, TextInput } from './api'
import type { TextEntry } from './entry'
import { TextPage } from './text-page'

afterEach(cleanup)

const goal: TextEntry = { id: 1, name: '目標', body: 'ログイン画面を作り終える', updatedAt: '2026-10-08T12:00:00.000Z' }
const doing: TextEntry = { id: 3, name: '今やってること', body: 'テストを書いている', updatedAt: '2026-10-08T12:10:00.000Z' }

/** 書き込みを記録し、送られた中身をそのまま保存したことにする代役 */
const createApi = (texts: TextEntry[] = [goal, doing], overrides: Partial<TextApi> = {}): TextApi => ({
  list: vi.fn(async () => texts),
  create: vi.fn(async (input: TextInput) => ({ id: 5, ...input, updatedAt: '2026-10-08T12:30:00.000Z' })),
  update: vi.fn(async (id: number, input: TextInput) => ({ id, ...input, updatedAt: '2026-10-08T12:30:00.000Z' })),
  remove: vi.fn(async () => undefined),
  ...overrides,
})

/** 保存済みのテキスト1件の領域 */
const textRegion = (name: string): Promise<HTMLElement> => screen.findByRole('group', { name: `テキスト「${name}」` })

describe('テキストの一覧', () => {
  test('保存済みのテキストを、名前と本文の入力欄で出す', async () => {
    render(<TextPage api={createApi()} />)

    const region = await textRegion('目標')
    expect(within(region).getByRole('textbox', { name: '名前' })).toHaveValue('目標')
    expect(within(region).getByRole('textbox', { name: '本文' })).toHaveValue('ログイン画面を作り終える')
    expect(await textRegion('今やってること')).toBeInTheDocument()
  })

  test('読み込めなければ理由を出す', async () => {
    render(<TextPage api={createApi([], { list: vi.fn(async () => Promise.reject(new Error('Workerにつながりません'))) })} />)

    expect(await screen.findByText(/Workerにつながりません/)).toBeInTheDocument()
  })
})

describe('書き換え', () => {
  test('本文を書き換えて保存すると、Workerに書き換えてもらう', async () => {
    const api = createApi()
    render(<TextPage api={api} />)
    const region = await textRegion('目標')

    const body = within(region).getByRole('textbox', { name: '本文' })
    await userEvent.clear(body)
    await userEvent.type(body, 'ログイン画面をデプロイする')
    await userEvent.click(within(region).getByRole('button', { name: '保存する' }))

    expect(api.update).toHaveBeenCalledWith(1, { name: '目標', body: 'ログイン画面をデプロイする' })
    expect(await screen.findByText('「目標」を保存しました')).toBeInTheDocument()
  })

  test('変えていないあいだは保存できない', async () => {
    render(<TextPage api={createApi()} />)

    expect(within(await textRegion('目標')).getByRole('button', { name: '保存する' })).toBeDisabled()
  })

  test('保存していない変更があるあいだは、ページを離れる前に確認を出す', async () => {
    render(<TextPage api={createApi()} />)
    const region = await textRegion('目標')
    expect(hasUnsavedChanges()).toBe(false)

    await userEvent.type(within(region).getByRole('textbox', { name: '本文' }), '！')

    expect(hasUnsavedChanges()).toBe(true)
  })

  test('Workerが拒んだら、問題点を1行ずつ出す', async () => {
    const api = createApi([goal, doing], {
      update: vi.fn(async () =>
        Promise.reject(new ApiError(400, 'invalid-config', 'テキストに問題があります', ['name: 「今やってること」という名前のテキストはもうあります'])),
      ),
    })
    render(<TextPage api={api} />)
    const region = await textRegion('目標')

    const name = within(region).getByRole('textbox', { name: '名前' })
    await userEvent.clear(name)
    await userEvent.type(name, '今やってること')
    await userEvent.click(within(region).getByRole('button', { name: '保存する' }))

    // 失敗の行は改行でつないで1つの要素に出る
    expect(await screen.findByText(/・名前: 「今やってること」という名前のテキストはもうあります/)).toBeInTheDocument()
  })
})

describe('追加と削除', () => {
  test('名前と本文を入れて追加すると、一覧に加わる', async () => {
    const api = createApi([])
    render(<TextPage api={api} />)
    const form = await screen.findByRole('group', { name: 'テキストを追加' })

    await userEvent.type(within(form).getByRole('textbox', { name: '名前' }), '目標')
    await userEvent.type(within(form).getByRole('textbox', { name: '本文' }), 'ログイン画面を作り終える')
    await userEvent.click(within(form).getByRole('button', { name: '追加する' }))

    expect(api.create).toHaveBeenCalledWith({ name: '目標', body: 'ログイン画面を作り終える' })
    expect(await textRegion('目標')).toBeInTheDocument()
    // 追加したら入力欄は空に戻す
    expect(within(form).getByRole('textbox', { name: '名前' })).toHaveValue('')
  })

  test('確かめてから消すと、一覧から消える', async () => {
    const api = createApi()
    render(<TextPage api={api} />)

    await userEvent.click(within(await textRegion('目標')).getByRole('button', { name: '消す' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'テキストを消す' }))

    expect(api.remove).toHaveBeenCalledWith(1)
    await waitFor(() => expect(screen.queryByRole('group', { name: 'テキスト「目標」' })).not.toBeInTheDocument())
  })
})
