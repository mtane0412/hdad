// @vitest-environment jsdom
/**
 * ツイスターのカード（BGM の設定と試し再生）のテスト
 *
 * 確かめること:
 * - 対戦のあいだ流す BGM に選べるのはアップロード済みの音声と「流さない」だけで、保存してある BGM が選ばれていること
 * - 選んだ BGM と音量をWorkerへ送って保存し、保存したことを知らせること
 * - 保存を断られたら、問題点を項目の名前に読み替えて1行ずつ出すこと
 * - 設定を読めなければ、選択欄を出さずに理由を出すこと
 * - 未保存の変更があるあいだは試し再生を押せないこと（試し再生は保存済みの BGM で流れるため）
 * （試し再生そのものは trigger-page.test.tsx が確かめる）
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '@/core/api'
import type { TwisterSound } from '@/twister/sound'
import type { MediaItem } from './api'
import { TwisterCard, type TwisterApi } from './twister-card'

/** アップロード済みの素材。対戦の曲と効果音は音声、拍手の動画はアラート用 */
const battleBgm: MediaItem = { id: 'media-taisen', name: '対戦のテーマ.mp3', kind: 'audio', contentType: 'audio/mpeg', size: 3 * 1024 * 1024, uploadedAt: '2026-10-01T00:00:00Z' }
const jajeanSound: MediaItem = { id: 'media-jajean', name: 'ジャジャーン.mp3', kind: 'audio', contentType: 'audio/mpeg', size: 40 * 1024, uploadedAt: '2026-10-02T00:00:00Z' }
const applauseVideo: MediaItem = { id: 'media-hakushu', name: '拍手.webm', kind: 'video', contentType: 'video/webm', size: 2 * 1024 * 1024, uploadedAt: '2026-09-01T00:00:00Z' }
const media = [battleBgm, jajeanSound, applauseVideo]

/** 対戦の曲を選んで保存してある設定 */
const savedSound: TwisterSound = { bgm: 'media-taisen', bgmVolume: 0.3 }

const fakeApi = (overrides: Partial<TwisterApi> = {}): TwisterApi => ({
  twisterSound: vi.fn(async () => savedSound),
  saveTwisterSound: vi.fn(async (sound: TwisterSound) => sound),
  playTwisterDemo: vi.fn(async () => 'レイドした人（試し） vs 配信者'),
  ...overrides,
})

const BGM_LABEL = 'BGM（対戦のあいだ流す）'

afterEach(cleanup)

describe('TwisterCard', () => {
  test('選べるのは「流さない」とアップロード済みの音声だけで、保存してある BGM が選ばれている', async () => {
    render(<TwisterCard api={fakeApi()} media={media} />)

    const select = await screen.findByLabelText(BGM_LABEL)
    expect(select).toHaveValue('media-taisen')
    const options = within(select).getAllByRole('option').map((option) => option.textContent)
    expect(options).toEqual(['流さない', '対戦のテーマ.mp3', 'ジャジャーン.mp3'])
  })

  test('BGM を選び直して保存すると、選んだ BGM と音量をWorkerへ送り、保存したことを知らせる', async () => {
    const api = fakeApi()
    render(<TwisterCard api={api} media={media} />)

    await userEvent.selectOptions(await screen.findByLabelText(BGM_LABEL), 'media-jajean')
    expect(screen.getByText('未保存の変更があります')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'BGM を保存' }))

    expect(api.saveTwisterSound).toHaveBeenCalledWith({ bgm: 'media-jajean', bgmVolume: 0.3 })
    expect(await screen.findByText('ツイスターの BGM を保存しました')).toBeInTheDocument()
    expect(screen.queryByText('未保存の変更があります')).not.toBeInTheDocument()
  })

  test('「流さない」を選んで保存すると、BGM を null にして送る', async () => {
    const api = fakeApi()
    render(<TwisterCard api={api} media={media} />)

    await userEvent.selectOptions(await screen.findByLabelText(BGM_LABEL), '')
    await userEvent.click(screen.getByRole('button', { name: 'BGM を保存' }))

    expect(api.saveTwisterSound).toHaveBeenCalledWith({ bgm: null, bgmVolume: 0.3 })
  })

  test('保存を断られたら、問題点を項目の名前に読み替えて1行ずつ出す', async () => {
    const api = fakeApi({
      saveTwisterSound: vi.fn(async () => {
        throw new ApiError(400, 'invalid_config', '設定に問題があります', ['bgm: 素材「media-jajean」が存在しません', 'bgmVolume: 0〜1 の数で指定してください'])
      }),
    })
    render(<TwisterCard api={api} media={media} />)

    await userEvent.selectOptions(await screen.findByLabelText(BGM_LABEL), 'media-jajean')
    await userEvent.click(screen.getByRole('button', { name: 'BGM を保存' }))

    expect(await screen.findByText(/・BGM（対戦のあいだ流す）: 素材「media-jajean」が存在しません/)).toBeInTheDocument()
    expect(screen.getByText(/・BGMの音量: 0〜1 の数で指定してください/)).toBeInTheDocument()
  })

  test('設定を読めなければ、選択欄を出さずに理由を出す', async () => {
    const api = fakeApi({
      twisterSound: vi.fn(async () => {
        throw new Error('Workerにつながりません')
      }),
    })
    render(<TwisterCard api={api} media={media} />)

    expect(await screen.findByText('Workerにつながりません')).toBeInTheDocument()
    expect(screen.queryByLabelText(BGM_LABEL)).not.toBeInTheDocument()
  })

  test('未保存の変更があるあいだは試し再生を押せない（試し再生は保存済みの BGM で流れ、選び直した BGM と食い違うため）', async () => {
    render(<TwisterCard api={fakeApi()} media={media} />)

    const playButton = screen.getByRole('button', { name: 'ツイスターを試しに流す' })
    await userEvent.selectOptions(await screen.findByLabelText(BGM_LABEL), 'media-jajean')

    expect(playButton).toBeDisabled()
  })
})
