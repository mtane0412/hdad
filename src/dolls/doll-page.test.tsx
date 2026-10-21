// @vitest-environment jsdom
/**
 * 人形のページ（/dolls/）のテスト
 *
 * 確かめること:
 * - 人形の組を、ふつうの人形とスーパー人形の名前で1行ずつ出し、いまの人形に印を付けること
 * - 組を追加できること（名前を入れ、画像はアップロード済みの画像から選ぶ）
 * - いまの人形を選び直せること
 * - 組を消せること（確かめてから行う）
 * - Worker が拒んだ理由（問題点）を項目の名前に読み替えて出し、読み込めなかった理由も黙らずに出すこと
 * - 追加しかけの組があるあいだは、ページを離れる前に確認を出すこと（useUnsavedChanges）
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { MediaItem } from '@/admin/api'
import { hasUnsavedChanges } from '@/app/router'
import { ApiError } from '@/core/api'
import type { DollApi, DollSetInput } from './api'
import type { DollSet } from './doll'
import { DollPage } from './doll-page'

afterEach(cleanup)

/** アップロード済みの素材。人形の画像に選べるのは画像だけ */
const media: MediaItem[] = [
  { id: 'image-bear', name: 'bear.png', kind: 'image', contentType: 'image/png', size: 100, uploadedAt: '2026-10-21T10:00:00.000Z' },
  { id: 'image-super-bear', name: 'super-bear.png', kind: 'image', contentType: 'image/png', size: 100, uploadedAt: '2026-10-21T10:00:00.000Z' },
  { id: 'sound-fanfare', name: 'fanfare.mp3', kind: 'audio', contentType: 'audio/mpeg', size: 100, uploadedAt: '2026-10-21T10:00:00.000Z' },
]

const bears: DollSet = {
  id: 1,
  normal: { name: 'クマ人形', mediaId: 'image-bear' },
  super: { name: 'スーパークマ人形', mediaId: 'image-super-bear' },
  current: true,
  updatedAt: '2026-10-21T12:00:00.000Z',
}

const cats: DollSet = {
  id: 2,
  normal: { name: 'ネコ人形', mediaId: 'image-bear' },
  super: { name: 'スーパーネコ人形', mediaId: 'image-super-bear' },
  current: false,
  updatedAt: '2026-10-21T12:00:00.000Z',
}

/** 書き込みを記録し、送られた中身をそのまま保存したことにする代役 */
const createApi = (sets: DollSet[] = [bears, cats], overrides: Partial<DollApi> = {}): DollApi => ({
  list: vi.fn(async () => ({ sets, holdings: [] })),
  create: vi.fn(async (input: DollSetInput) => ({ id: 5, ...input, current: false, updatedAt: '2026-10-21T12:30:00.000Z' })),
  update: vi.fn(async (id: number, input: DollSetInput) => ({ id, ...input, current: false, updatedAt: '2026-10-21T12:30:00.000Z' })),
  remove: vi.fn(async () => undefined),
  selectCurrent: vi.fn(async (setId: number | null) => sets.map((set) => ({ ...set, current: set.id === setId }))),
  change: vi.fn(),
  prize: vi.fn(),
  savePrize: vi.fn(),
  ...overrides,
})

const renderPage = (api: DollApi) => render(<DollPage api={api} loadMedia={async () => media} />)

/** 組の行を、入力欄を開いた状態で返す（すでに開いていれば押さない） */
const openSet = async (normalName: string): Promise<HTMLElement> => {
  const region = await screen.findByRole('listitem', { name: `人形「${normalName}」` })
  const closed = within(region).queryByRole('button', { name: new RegExp(`^${normalName}`), expanded: false })
  if (closed !== null) await userEvent.click(closed)
  return region
}

describe('人形の組の一覧', () => {
  test('ふつうの人形とスーパー人形の名前を1行ずつ出し、いまの人形に印を付ける', async () => {
    renderPage(createApi())

    const bearRow = within(await screen.findByRole('listitem', { name: '人形「クマ人形」' }))
    expect(bearRow.getByText('スーパークマ人形')).toBeInTheDocument()
    expect(bearRow.getByText('いまの人形')).toBeInTheDocument()
    const catRow = within(await screen.findByRole('listitem', { name: '人形「ネコ人形」' }))
    expect(catRow.queryByText('いまの人形')).not.toBeInTheDocument()
  })

  test('読み込めなかったら理由を出す', async () => {
    renderPage(createApi([], { list: vi.fn(async () => Promise.reject(new Error('Workerに届きませんでした'))) }))

    expect(await screen.findByText(/Workerに届きませんでした/)).toBeInTheDocument()
  })
})

describe('いまの人形', () => {
  test('別の組をいまの人形にすると、印がその組へ移る', async () => {
    const api = createApi()
    renderPage(api)

    const catRegion = await openSet('ネコ人形')
    await userEvent.click(within(catRegion).getByRole('button', { name: 'いまの人形にする' }))

    expect(api.selectCurrent).toHaveBeenCalledWith(2)
    expect(await within(catRegion).findByText('いまの人形')).toBeInTheDocument()
    expect(within(await screen.findByRole('listitem', { name: '人形「クマ人形」' })).queryByText('いまの人形')).not.toBeInTheDocument()
  })

  test('いまの人形を外せる', async () => {
    const api = createApi()
    renderPage(api)

    const bearRegion = await openSet('クマ人形')
    await userEvent.click(within(bearRegion).getByRole('button', { name: 'いまの人形から外す' }))

    expect(api.selectCurrent).toHaveBeenCalledWith(null)
  })
})

describe('組の追加・書き換え・削除', () => {
  test('名前を入れて画像を選ぶと、組を追加する。画像の選択肢は画像の素材だけ', async () => {
    const api = createApi([])
    renderPage(api)

    const form = within(await screen.findByRole('group', { name: '人形を追加' }))
    expect(form.queryAllByRole('option', { name: 'fanfare.mp3' })).toHaveLength(0)
    await userEvent.type(form.getByRole('textbox', { name: 'ふつうの人形の名前' }), 'クマ人形')
    await userEvent.selectOptions(form.getByRole('combobox', { name: 'ふつうの人形の画像' }), 'image-bear')
    await userEvent.type(form.getByRole('textbox', { name: 'スーパー人形の名前' }), 'スーパークマ人形')
    await userEvent.selectOptions(form.getByRole('combobox', { name: 'スーパー人形の画像' }), 'image-super-bear')
    expect(hasUnsavedChanges()).toBe(true)
    await userEvent.click(form.getByRole('button', { name: '追加する' }))

    expect(api.create).toHaveBeenCalledWith({ normal: bears.normal, super: bears.super })
    expect(await screen.findByRole('listitem', { name: '人形「クマ人形」' })).toBeInTheDocument()
    expect(hasUnsavedChanges()).toBe(false)
  })

  test('名前を書き換えて保存する', async () => {
    const api = createApi()
    renderPage(api)

    const region = await openSet('クマ人形')
    const name = within(region).getByRole('textbox', { name: 'ふつうの人形の名前' })
    await userEvent.clear(name)
    await userEvent.type(name, 'ちびクマ人形')
    await userEvent.click(within(region).getByRole('button', { name: 'クマ人形 を保存する' }))

    expect(api.update).toHaveBeenCalledWith(1, { normal: { name: 'ちびクマ人形', mediaId: 'image-bear' }, super: bears.super })
  })

  test('組は確かめてから消す', async () => {
    const api = createApi()
    renderPage(api)

    const region = await openSet('ネコ人形')
    await userEvent.click(within(region).getByRole('button', { name: '消す' }))
    await userEvent.click(await screen.findByRole('button', { name: '人形を消す' }))

    expect(api.remove).toHaveBeenCalledWith(2)
    expect(screen.queryByRole('listitem', { name: '人形「ネコ人形」' })).not.toBeInTheDocument()
  })

  test('Worker が拒んだ理由を、項目の名前に読み替えて出す', async () => {
    const api = createApi([], {
      create: vi.fn(async () => Promise.reject(new ApiError(400, 'invalid-config', '人形に問題があります', ['normal.name: 名前を入れてください']))),
    })
    renderPage(api)

    const form = within(await screen.findByRole('group', { name: '人形を追加' }))
    await userEvent.click(form.getByRole('button', { name: '追加する' }))

    expect(await screen.findByText(/・ふつうの人形の名前: 名前を入れてください/)).toBeInTheDocument()
  })
})
