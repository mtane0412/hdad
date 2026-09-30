// @vitest-environment jsdom
/**
 * 画面の取り込みのページのテスト
 *
 * 確かめること:
 * - 保存済みの設定が入力欄に出ること
 * - 入力した値がそのまま Worker へ渡ること（空欄を 0 に丸めない）
 * - コレクションのURLを貼ったら、その末尾のIDだけを送ること
 * - Worker が返した問題点が並んで出ること（検証は Worker だけが持つため）
 * - つなぎ先を変えたら、OBSの再読み込みが要ると知らせること
 * - 設定を読めなかったときに、黙って既定に倒さず理由を出すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '@/core/api'
import type { ScreenSettings } from './api'
import { ScreenPage } from './screen-page'

const savedConfig: ScreenSettings = {
  host: 'localhost',
  port: 4455,
  password: 'obsのパスワード',
  intervalSeconds: 60,
  collectionId: '',
}

/** 配信者が Gyazo の画面からコピーしてくるコレクションのURL */
const collectionUrl = 'https://gyazo.com/collections/f19e74cebe47c9cadad31b6790098eac'

afterEach(cleanup)

const renderPage = (api: { load: () => Promise<ScreenSettings>; save: (settings: ScreenSettings) => Promise<ScreenSettings> }) => {
  render(<ScreenPage api={api} />)
}

const workingFakeApi = () => ({
  load: vi.fn(async () => savedConfig),
  save: vi.fn(async (settings: ScreenSettings) => settings),
})

describe('画面の取り込みのページ', () => {
  test('保存済みの設定を入力欄に出す', async () => {
    renderPage(workingFakeApi())

    expect(await screen.findByLabelText('obs-websocket のポート番号')).toHaveValue(4455)
    expect(screen.getByLabelText('obs-websocket のパスワード')).toHaveValue('obsのパスワード')
    expect(screen.getByLabelText('撮る間隔（秒）')).toHaveValue(60)
  })

  test('入力した値をそのまま保存する', async () => {
    const api = workingFakeApi()
    renderPage(api)

    const intervalField = await screen.findByLabelText('撮る間隔（秒）')
    await userEvent.clear(intervalField)
    await userEvent.type(intervalField, '90')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ ...savedConfig, intervalSeconds: 90 }))
  })

  test('コレクションのURLを貼ったら、末尾のIDだけを送る', async () => {
    const api = workingFakeApi()
    renderPage(api)

    await userEvent.type(await screen.findByLabelText('上げ先の Gyazo のコレクション（任意）'), collectionUrl)
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ ...savedConfig, collectionId: 'f19e74cebe47c9cadad31b6790098eac' }))
  })

  test('コレクションを空のままにすれば、空のまま送る（どのコレクションにも入れない）', async () => {
    const api = workingFakeApi()
    renderPage(api)

    await screen.findByLabelText('上げ先の Gyazo のコレクション（任意）')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(api.save).toHaveBeenCalledWith(savedConfig))
  })

  test('空欄は 0 に丸めず、数として読めない値のまま Worker へ渡す', async () => {
    const api = workingFakeApi()
    renderPage(api)

    await userEvent.clear(await screen.findByLabelText('撮る間隔（秒）'))
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ ...savedConfig, intervalSeconds: Number.NaN }))
  })

  test('Workerが返した問題点を並べて出す', async () => {
    const api = workingFakeApi()
    api.save = vi.fn(async () => {
      throw new ApiError(400, 'invalid-config', '画面取り込みの設定に問題があります', ['intervalSeconds: 15〜600 の整数で指定してください'])
    })
    renderPage(api)

    await screen.findByLabelText('撮る間隔（秒）')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))

    // 問題点は1つの要素に改行で並ぶので、部分一致で確かめる
    expect(await screen.findByText(/・intervalSeconds: 15〜600 の整数で指定してください/)).toBeInTheDocument()
  })

  test('つなぎ先を変えたら、OBSの再読み込みが要ると知らせる', async () => {
    renderPage(workingFakeApi())

    const portField = await screen.findByLabelText('obs-websocket のポート番号')
    await userEvent.clear(portField)
    await userEvent.type(portField, '4456')

    expect(await screen.findByText('OBSの再読み込みが要ります')).toBeInTheDocument()
  })

  test('設定を読めなければ、黙って既定に倒さず理由を出す', async () => {
    renderPage({ load: vi.fn(async () => Promise.reject(new Error('Workerにつながりません'))), save: vi.fn(async (s) => s) })

    expect(await screen.findByText('Workerにつながりません')).toBeInTheDocument()
  })
})
