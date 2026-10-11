// @vitest-environment jsdom
/**
 * ペロペロのカード（効果音の設定と試し再生）のテスト
 *
 * 確かめること:
 * - 効果音に選べるのはアップロード済みの音声と「鳴らさない」だけで、保存してある効果音が選ばれていること
 * - 選んだ効果音と音量をWorkerへ送って保存し、保存したことを知らせること
 * - 保存を断られたら、問題点を項目の名前に読み替えて1行ずつ出すこと
 * - 設定を読めなければ、選択欄を出さずに理由を出すこと
 * - 未保存の変更があるあいだは試し再生を押せないこと（試し再生は保存済みの効果音で鳴るため）
 * （試し再生そのものは trigger-page.test.tsx が確かめる）
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '@/core/api'
import type { LickSound } from '@/lick/sound'
import type { MediaItem } from './api'
import { LickCard, type LickApi } from './lick-card'

/** アップロード済みの素材。ジュルジュルとペチャペチャは音声、拍手の動画はアラート用 */
const juruSound: MediaItem = { id: 'media-juru', name: 'ジュルジュル.mp3', kind: 'audio', contentType: 'audio/mpeg', size: 60 * 1024, uploadedAt: '2026-10-11T00:00:00Z' }
const pechaSound: MediaItem = { id: 'media-pecha', name: 'ペチャペチャ.mp3', kind: 'audio', contentType: 'audio/mpeg', size: 40 * 1024, uploadedAt: '2026-10-11T00:00:00Z' }
const applauseVideo: MediaItem = { id: 'media-hakushu', name: '拍手.webm', kind: 'video', contentType: 'video/webm', size: 2 * 1024 * 1024, uploadedAt: '2026-09-01T00:00:00Z' }
const media = [juruSound, pechaSound, applauseVideo]

/** ジュルジュルを選んで保存してある設定 */
const savedSound: LickSound = { sound: 'media-juru', volume: 0.6 }

const fakeApi = (overrides: Partial<LickApi> = {}): LickApi => ({
  lickSound: vi.fn(async () => savedSound),
  saveLickSound: vi.fn(async (sound: LickSound) => sound),
  playLickDemo: vi.fn(async () => '視聴者（試し）'),
  ...overrides,
})

const SOUND_LABEL = '効果音（舌が触れるたびに鳴らす）'

afterEach(cleanup)

describe('LickCard', () => {
  test('選べるのは「鳴らさない」とアップロード済みの音声だけで、保存してある効果音が選ばれている', async () => {
    render(<LickCard api={fakeApi()} media={media} />)

    const select = await screen.findByLabelText(SOUND_LABEL)
    expect(select).toHaveValue('media-juru')
    const options = within(select).getAllByRole('option').map((option) => option.textContent)
    expect(options).toEqual(['鳴らさない', 'ジュルジュル.mp3', 'ペチャペチャ.mp3'])
  })

  test('効果音を選び直して保存すると、選んだ効果音と音量をWorkerへ送り、保存したことを知らせる', async () => {
    const api = fakeApi()
    render(<LickCard api={api} media={media} />)

    await userEvent.selectOptions(await screen.findByLabelText(SOUND_LABEL), 'media-pecha')
    expect(screen.getByText('未保存の変更があります')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '効果音を保存' }))

    expect(api.saveLickSound).toHaveBeenCalledWith({ sound: 'media-pecha', volume: 0.6 })
    expect(await screen.findByText('ペロペロの効果音を保存しました')).toBeInTheDocument()
    expect(screen.queryByText('未保存の変更があります')).not.toBeInTheDocument()
  })

  test('「鳴らさない」を選んで保存すると、効果音を null にして送る', async () => {
    const api = fakeApi()
    render(<LickCard api={api} media={media} />)

    await userEvent.selectOptions(await screen.findByLabelText(SOUND_LABEL), '')
    await userEvent.click(screen.getByRole('button', { name: '効果音を保存' }))

    expect(api.saveLickSound).toHaveBeenCalledWith({ sound: null, volume: 0.6 })
  })

  test('保存を断られたら、問題点を項目の名前に読み替えて1行ずつ出す', async () => {
    const api = fakeApi({
      saveLickSound: vi.fn(async () => {
        throw new ApiError(400, 'invalid_config', '設定に問題があります', ['sound: 素材「media-pecha」が存在しません', 'volume: 0〜1 の数で指定してください'])
      }),
    })
    render(<LickCard api={api} media={media} />)

    await userEvent.selectOptions(await screen.findByLabelText(SOUND_LABEL), 'media-pecha')
    await userEvent.click(screen.getByRole('button', { name: '効果音を保存' }))

    expect(await screen.findByText(/・効果音（舌が触れるたびに鳴らす）: 素材「media-pecha」が存在しません/)).toBeInTheDocument()
    expect(screen.getByText(/・効果音の音量: 0〜1 の数で指定してください/)).toBeInTheDocument()
  })

  test('設定を読めなければ、選択欄を出さずに理由を出す', async () => {
    const api = fakeApi({
      lickSound: vi.fn(async () => {
        throw new Error('Workerにつながりません')
      }),
    })
    render(<LickCard api={api} media={media} />)

    expect(await screen.findByText('Workerにつながりません')).toBeInTheDocument()
    expect(screen.queryByLabelText(SOUND_LABEL)).not.toBeInTheDocument()
  })

  test('未保存の変更があるあいだは試し再生を押せない（試し再生は保存済みの効果音で鳴り、選び直した効果音と食い違うため）', async () => {
    render(<LickCard api={fakeApi()} media={media} />)

    const playButton = screen.getByRole('button', { name: 'ペロペロを試しに流す' })
    await userEvent.selectOptions(await screen.findByLabelText(SOUND_LABEL), 'media-pecha')

    expect(playButton).toBeDisabled()
  })
})
