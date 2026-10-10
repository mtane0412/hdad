// @vitest-environment jsdom
/**
 * アップロードのページ（素材の一覧・アップロード・削除）のテスト
 *
 * 確かめること:
 * - 素材の名前・種類・大きさを一覧に出すこと
 * - 選んだファイルをアップロードすると、一覧の先頭に追加されること
 * - 削除は確認してから行うこと（確認でやめたら削除しない）
 * - 失敗は黙って無視せず、理由を出すこと
 */
import type { TownTourNarration } from '@/town-tour/narration'
import type { TownTourSound } from '@/town-tour/sound'
import type { TwisterSound } from '@/twister/sound'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { type AdminApi, type MediaItem } from './api'
import { MediaPage } from './media-page'

const applauseVideo: MediaItem = { id: 'media-hakushu', name: '拍手.webm', kind: 'video', contentType: 'video/webm', size: 2 * 1024 * 1024, uploadedAt: '2026-09-01T00:00:00Z' }
const fireworksImage: MediaItem = { id: 'media-hanabi', name: '花火.png', kind: 'image', contentType: 'image/png', size: 2048, uploadedAt: '2026-09-02T00:00:00Z' }

/** 素材2つが保存されている状態のWorkerの代役 */
const fakeApi = (overrides: Partial<AdminApi> = {}): AdminApi => ({
  me: vi.fn(async () => null),
  logout: vi.fn(async () => {}),
  config: vi.fn(async () => []),
  saveConfig: vi.fn(async () => []),
  media: vi.fn(async () => [applauseVideo, fireworksImage]),
  upload: vi.fn(async () => fireworksImage),
  removeMedia: vi.fn(async () => {}),
  rotateOverlayKey: vi.fn(async () => 'atarashii-key'),
  playTownTourDemo: vi.fn(async () => '試し再生: 本日は東京都千代田区をご紹介します'),
  playTwisterDemo: vi.fn(async () => 'レイドした人（試し） vs 配信者'),
  playKanjiQuizDemo: vi.fn(async () => '漢検6級「境内」'),
  townTourSound: vi.fn(async () => ({ slots: { bgm: null, opening: null, zoom: null, landing: null, item: null, closing: null }, bgmVolume: 0.3, effectVolume: 0.6 })),
  saveTownTourSound: vi.fn(async (sound: TownTourSound) => sound),
  twisterSound: vi.fn(async () => ({ bgm: null, bgmVolume: 0.3 })),
  saveTwisterSound: vi.fn(async (sound: TwisterSound) => sound),
  townTourNarration: vi.fn(async () => ({ enabled: false, speaker: 3, speed: 1 })),
  saveTownTourNarration: vi.fn(async (narration: TownTourNarration) => narration),
  rewards: vi.fn(async () => []),
  createReward: vi.fn(async () => {
    throw new Error('このテストでは報酬を変更しません')
  }),
  updateReward: vi.fn(async () => {
    throw new Error('このテストでは報酬を変更しません')
  }),
  removeReward: vi.fn(async () => {}),
  ...overrides,
})

/** 操作の結果のお知らせ。役割ではなく文言で探す */
const notice = (text: string): Promise<HTMLElement> => screen.findByText(new RegExp(text))

afterEach(cleanup)

describe('素材の一覧', () => {
  test('素材の名前・種類・大きさを一覧に出す', async () => {
    render(<MediaPage api={fakeApi()} />)

    const list = await screen.findByRole('list', { name: '素材の一覧' })
    expect(within(list).getByText('拍手.webm')).toBeInTheDocument()
    expect(within(list).getByText('動画・2.0 MB')).toBeInTheDocument()
    expect(within(list).getByText('花火.png')).toBeInTheDocument()
    expect(within(list).getByText('画像・2.0 KB')).toBeInTheDocument()
  })

  test('素材がなければ、まだないことを伝える', async () => {
    render(<MediaPage api={fakeApi({ media: async () => [] })} />)

    expect(await screen.findByText('素材はまだありません。')).toBeInTheDocument()
  })
})

describe('アップロード', () => {
  test('選んだファイルをアップロードすると、一覧の先頭に追加される', async () => {
    const confettiImage: MediaItem = { ...fireworksImage, id: 'media-kamifubuki', name: '紙吹雪.png' }
    const api = fakeApi({ upload: vi.fn(async () => confettiImage) })
    render(<MediaPage api={api} />)
    const file = new File(['紙吹雪'], '紙吹雪.png', { type: 'image/png' })

    await userEvent.upload(await screen.findByLabelText('ファイル（1つ50MBまで）'), file)
    await userEvent.click(screen.getByRole('button', { name: 'アップロード' }))

    expect(await notice('素材「紙吹雪.png」をアップロードしました')).toBeInTheDocument()
    expect(api.upload).toHaveBeenCalledWith(file)
    const items = within(screen.getByRole('list', { name: '素材の一覧' })).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('紙吹雪.png')
  })

  test('ファイルを選ばずにアップロードしようとしたら、理由を出す', async () => {
    const api = fakeApi()
    render(<MediaPage api={api} />)

    await userEvent.click(await screen.findByRole('button', { name: 'アップロード' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('アップロードするファイルを選んでください')
    expect(api.upload).not.toHaveBeenCalled()
  })
})

describe('削除', () => {
  test('削除はアイコンだけのボタンにし、名前は読み上げとホバー（title）に残す', async () => {
    render(<MediaPage api={fakeApi()} />)

    const deleteButton = await screen.findByRole('button', { name: '花火.png を削除' })
    expect(deleteButton).toHaveTextContent('')
    expect(deleteButton).toHaveAttribute('title', '花火.png を削除')
  })

  test('削除は確認してから行い、一覧から消す', async () => {
    const api = fakeApi()
    render(<MediaPage api={api} />)

    await userEvent.click(await screen.findByRole('button', { name: '花火.png を削除' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('素材「花火.png」を削除しますか？')
    expect(api.removeMedia).not.toHaveBeenCalled()

    await userEvent.click(within(dialog).getByRole('button', { name: '削除する' }))

    expect(await notice('素材「花火.png」を削除しました')).toBeInTheDocument()
    expect(api.removeMedia).toHaveBeenCalledWith('media-hanabi')
    expect(within(screen.getByRole('list', { name: '素材の一覧' })).queryByText('花火.png')).not.toBeInTheDocument()
  })

  test('確認でやめたら、素材は削除しない', async () => {
    const api = fakeApi()
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
        api={fakeApi({
          media: async () => {
            throw new Error('Workerに接続できません')
          },
        })}
      />,
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('素材を表示できません')
    expect(alert).toHaveTextContent('Workerに接続できません')
    expect(screen.queryByRole('button', { name: 'アップロード' })).not.toBeInTheDocument()
  })
})
