// @vitest-environment jsdom
/**
 * 市町村紹介のカードのナレーションの区画（issue #255）のテスト
 *
 * 確かめること:
 * - 保存してある設定（読み上げるか・話者ID・読み上げ速度）を入力欄に出すこと
 * - 読み上げるにして保存すると、入力した話者と速度と一緒にWorkerへ送り、保存したことを知らせること
 * - 未保存の変更があることを知らせ、親（カード）にも伝えること（試し再生を止めるため）
 * - 保存を断られたら、問題点を入力欄の名前に読み替えて1行ずつ出すこと
 * - 設定を読めなければ、入力欄を出さずに理由を出すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '@/core/api'
import type { TownTourNarration } from '@/town-tour/narration'
import { TownTourNarrationSection, type TownTourNarrationApi } from './town-tour-narration-section'

/** 読み上げない設定のまま、話者だけ「ずんだもん（ノーマル）」で保存してある */
const savedNarration: TownTourNarration = { enabled: false, speaker: 3, speed: 1 }

const fakeApi = (overrides: Partial<TownTourNarrationApi> = {}): TownTourNarrationApi => ({
  townTourNarration: vi.fn(async () => savedNarration),
  saveTownTourNarration: vi.fn(async (narration: TownTourNarration) => narration),
  ...overrides,
})

afterEach(cleanup)

describe('TownTourNarrationSection', () => {
  test('保存してある設定を入力欄に出す', async () => {
    render(<TownTourNarrationSection api={fakeApi()} onUnsavedChange={vi.fn()} />)

    expect(await screen.findByRole('checkbox', { name: 'ナレーションで読み上げる' })).not.toBeChecked()
    expect(screen.getByLabelText('ナレーションの話者ID')).toHaveValue(3)
    expect(screen.getByLabelText('ナレーションの読み上げ速度')).toHaveValue(1)
  })

  test('読み上げるにして話者を変えて保存すると、Workerへ送り、保存したことを知らせる。変更中は親に未保存を伝える', async () => {
    const api = fakeApi()
    const onUnsavedChange = vi.fn()
    render(<TownTourNarrationSection api={api} onUnsavedChange={onUnsavedChange} />)

    await userEvent.click(await screen.findByRole('checkbox', { name: 'ナレーションで読み上げる' }))
    const speaker = screen.getByLabelText('ナレーションの話者ID')
    await userEvent.clear(speaker)
    await userEvent.type(speaker, '13')
    expect(screen.getByText('未保存の変更があります')).toBeInTheDocument()
    expect(onUnsavedChange).toHaveBeenLastCalledWith(true)
    await userEvent.click(screen.getByRole('button', { name: 'ナレーションを保存' }))

    expect(api.saveTownTourNarration).toHaveBeenCalledWith({ enabled: true, speaker: 13, speed: 1 })
    expect(await screen.findByText('市町村紹介のナレーションを保存しました')).toBeInTheDocument()
    expect(onUnsavedChange).toHaveBeenLastCalledWith(false)
  })

  test('保存を断られたら、問題点を入力欄の名前に読み替えて1行ずつ出す', async () => {
    const api = fakeApi({
      saveTownTourNarration: vi.fn(async () => {
        throw new ApiError(400, 'invalid-config', '市町村紹介のナレーションに問題があります', ['speed: 0.5〜2 の数で指定してください'])
      }),
    })
    render(<TownTourNarrationSection api={api} onUnsavedChange={vi.fn()} />)

    const speed = await screen.findByLabelText('ナレーションの読み上げ速度')
    await userEvent.clear(speed)
    await userEvent.type(speed, '5')
    await userEvent.click(screen.getByRole('button', { name: 'ナレーションを保存' }))

    expect(await screen.findByText(/・ナレーションの読み上げ速度: 0.5〜2 の数で指定してください/)).toBeInTheDocument()
  })

  test('設定を読めなければ、入力欄を出さずに理由を出す', async () => {
    const api = fakeApi({
      townTourNarration: vi.fn(async () => {
        throw new Error('Workerに届きませんでした')
      }),
    })
    render(<TownTourNarrationSection api={api} onUnsavedChange={vi.fn()} />)

    expect(await screen.findByText('Workerに届きませんでした')).toBeInTheDocument()
    expect(screen.queryByLabelText('ナレーションの話者ID')).not.toBeInTheDocument()
  })
})
