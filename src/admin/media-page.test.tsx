// @vitest-environment jsdom
/**
 * アップロードのページ（素材の一覧・アップロード・削除）のテスト
 *
 * 確かめること:
 * - 素材の名前・種類・大きさを一覧に出すこと
 * - 選んだファイルをアップロードすると、一覧の先頭に足されること
 * - 削除は確認してから行うこと（確認でやめたら削除しない）
 * - 失敗は黙って無視せず、理由を出すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { type AdminApi, type MediaItem } from './api'
import { MediaPage } from './media-page'

const 拍手の動画: MediaItem = { id: 'media-hakushu', name: '拍手.webm', kind: 'video', contentType: 'video/webm', size: 2 * 1024 * 1024, uploadedAt: '2026-09-01T00:00:00Z' }
const 花火の画像: MediaItem = { id: 'media-hanabi', name: '花火.png', kind: 'image', contentType: 'image/png', size: 2048, uploadedAt: '2026-09-02T00:00:00Z' }

/** 素材2つが保存されている状態のWorkerの代役 */
const 代役のAPI = (overrides: Partial<AdminApi> = {}): AdminApi => ({
  me: vi.fn(async () => null),
  logout: vi.fn(async () => {}),
  config: vi.fn(async () => []),
  saveConfig: vi.fn(async () => []),
  media: vi.fn(async () => [拍手の動画, 花火の画像]),
  upload: vi.fn(async () => 花火の画像),
  removeMedia: vi.fn(async () => {}),
  rotateOverlayKey: vi.fn(async () => 'atarashii-key'),
  rewards: vi.fn(async () => []),
  ...overrides,
})

/** 操作の結果のお知らせ。役割ではなく文言で探す */
const お知らせ = (text: string): Promise<HTMLElement> => screen.findByText(new RegExp(text))

afterEach(cleanup)

describe('素材の一覧', () => {
  test('素材の名前・種類・大きさを一覧に出す', async () => {
    render(<MediaPage api={代役のAPI()} />)

    const list = await screen.findByRole('list', { name: '素材の一覧' })
    expect(within(list).getByText('拍手.webm')).toBeInTheDocument()
    expect(within(list).getByText('動画・2.0 MB')).toBeInTheDocument()
    expect(within(list).getByText('花火.png')).toBeInTheDocument()
    expect(within(list).getByText('画像・2.0 KB')).toBeInTheDocument()
  })

  test('素材がなければ、まだないことを伝える', async () => {
    render(<MediaPage api={代役のAPI({ media: async () => [] })} />)

    expect(await screen.findByText('素材はまだありません。')).toBeInTheDocument()
  })
})

describe('アップロード', () => {
  test('選んだファイルをアップロードすると、一覧の先頭に足される', async () => {
    const 紙吹雪の画像: MediaItem = { ...花火の画像, id: 'media-kamifubuki', name: '紙吹雪.png' }
    const api = 代役のAPI({ upload: vi.fn(async () => 紙吹雪の画像) })
    render(<MediaPage api={api} />)
    const file = new File(['紙吹雪'], '紙吹雪.png', { type: 'image/png' })

    await userEvent.upload(await screen.findByLabelText('ファイル（1つ50MBまで）'), file)
    await userEvent.click(screen.getByRole('button', { name: 'アップロード' }))

    expect(await お知らせ('素材「紙吹雪.png」をアップロードしました')).toBeInTheDocument()
    expect(api.upload).toHaveBeenCalledWith(file)
    const items = within(screen.getByRole('list', { name: '素材の一覧' })).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('紙吹雪.png')
  })

  test('ファイルを選ばずにアップロードしようとしたら、理由を出す', async () => {
    const api = 代役のAPI()
    render(<MediaPage api={api} />)

    await userEvent.click(await screen.findByRole('button', { name: 'アップロード' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('アップロードするファイルを選んでください')
    expect(api.upload).not.toHaveBeenCalled()
  })
})

describe('削除', () => {
  test('削除は確認してから行い、一覧から消す', async () => {
    const api = 代役のAPI()
    render(<MediaPage api={api} />)

    await userEvent.click(await screen.findByRole('button', { name: '花火.png を削除' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('素材「花火.png」を削除しますか？')
    expect(api.removeMedia).not.toHaveBeenCalled()

    await userEvent.click(within(dialog).getByRole('button', { name: '削除する' }))

    expect(await お知らせ('素材「花火.png」を削除しました')).toBeInTheDocument()
    expect(api.removeMedia).toHaveBeenCalledWith('media-hanabi')
    expect(within(screen.getByRole('list', { name: '素材の一覧' })).queryByText('花火.png')).not.toBeInTheDocument()
  })

  test('確認でやめたら、素材は削除しない', async () => {
    const api = 代役のAPI()
    render(<MediaPage api={api} />)

    await userEvent.click(await screen.findByRole('button', { name: '花火.png を削除' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'やめる' }))

    expect(api.removeMedia).not.toHaveBeenCalled()
  })
})

describe('読み込みの失敗', () => {
  test('素材の一覧を取得できなければ、操作盤を出さずに理由を出す', async () => {
    render(
      <MediaPage
        api={代役のAPI({
          media: async () => {
            throw new Error('Workerに接続できません')
          },
        })}
      />,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('素材を表示できません: Workerに接続できません')
    expect(screen.queryByRole('button', { name: 'アップロード' })).not.toBeInTheDocument()
  })
})
