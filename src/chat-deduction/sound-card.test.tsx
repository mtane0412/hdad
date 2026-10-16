// @vitest-environment jsdom
/**
 * チャットで推理の音のカード（sound-card.tsx）のテスト
 *
 * 確かめること:
 * - 枠（BGM・開始・回答・不正解・正解・打ち切り）ごとに選べるのはアップロード済みの音声と「鳴らさない」だけで、保存してある音が選ばれていること
 * - 選んだ音と音量を Worker へ送って保存し、保存したことを知らせること
 * - 保存を断られたら、問題点を枠の名前に読み替えて1行ずつ出すこと
 * - 設定か素材の一覧を読めなければ、選択欄を出さずに理由を出すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { MediaItem } from '@/admin/api'
import { ApiError } from '@/core/api'
import { ChatDeductionSoundCard, type ChatDeductionSoundApi } from './sound-card'
import type { ChatDeductionSound } from './sound'

/** アップロード済みの素材。考える曲と正解の音は音声、拍手の動画はアラート用 */
const thinkingBgm: MediaItem = { id: 'media-thinking', name: '考え中.mp3', kind: 'audio', contentType: 'audio/mpeg', size: 3 * 1024 * 1024, uploadedAt: '2026-10-01T00:00:00Z' }
const pinponSound: MediaItem = { id: 'media-pinpon', name: 'ピンポン.mp3', kind: 'audio', contentType: 'audio/mpeg', size: 40 * 1024, uploadedAt: '2026-10-02T00:00:00Z' }
const applauseVideo: MediaItem = { id: 'media-hakushu', name: '拍手.webm', kind: 'video', contentType: 'video/webm', size: 2 * 1024 * 1024, uploadedAt: '2026-09-01T00:00:00Z' }

/** BGM に考える曲を選んで保存してある設定 */
const savedSound: ChatDeductionSound = {
  slots: { bgm: 'media-thinking', start: null, answered: null, wrong: null, correct: null, stopped: null },
  bgmVolume: 0.2,
  effectVolume: 0.6,
}

const fakeApi = (overrides: Partial<ChatDeductionSoundApi> = {}): ChatDeductionSoundApi => ({
  sound: vi.fn(async () => savedSound),
  saveSound: vi.fn(async (sound: ChatDeductionSound) => sound),
  ...overrides,
})

const loadMedia = vi.fn(async () => [thinkingBgm, pinponSound, applauseVideo])

const BGM_LABEL = 'BGM（ゲームを始めてから、正解か打ち切りまで流す）'
const CORRECT_LABEL = '正解（正解の解答が出たとき）'

afterEach(cleanup)

describe('ChatDeductionSoundCard', () => {
  test('枠ごとに選べるのは「鳴らさない」とアップロード済みの音声だけで、保存してある音が選ばれている', async () => {
    render(<ChatDeductionSoundCard api={fakeApi()} loadMedia={loadMedia} />)

    const select = await screen.findByLabelText(BGM_LABEL)
    expect(select).toHaveValue('media-thinking')
    expect(screen.getByLabelText(CORRECT_LABEL)).toHaveValue('')
    const options = within(select).getAllByRole('option').map((option) => option.textContent)
    expect(options).toEqual(['鳴らさない', '考え中.mp3', 'ピンポン.mp3'])
  })

  test('開始・回答・不正解・打ち切りの音も選べる', async () => {
    render(<ChatDeductionSoundCard api={fakeApi()} loadMedia={loadMedia} />)

    expect(await screen.findByLabelText('開始（ゲームを始めたとき）')).toHaveValue('')
    expect(screen.getByLabelText('回答（質問に答えたとき）')).toHaveValue('')
    expect(screen.getByLabelText('不正解（解答が外れたとき）')).toHaveValue('')
    expect(screen.getByLabelText('打ち切り（ゲームを終えたとき）')).toHaveValue('')
  })

  test('正解の音を選んで保存すると、選んだ音と音量を Worker へ送り、保存したことを知らせる', async () => {
    const api = fakeApi()
    render(<ChatDeductionSoundCard api={api} loadMedia={loadMedia} />)

    await userEvent.selectOptions(await screen.findByLabelText(CORRECT_LABEL), 'media-pinpon')
    expect(screen.getByText('未保存の変更があります')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '音を保存する' }))

    expect(api.saveSound).toHaveBeenCalledWith({ ...savedSound, slots: { ...savedSound.slots, correct: 'media-pinpon' } })
    expect(await screen.findByText('チャットで推理の音を保存しました')).toBeInTheDocument()
    expect(screen.queryByText('未保存の変更があります')).not.toBeInTheDocument()
  })

  test('保存を断られたら、問題点を枠の名前に読み替えて1行ずつ出す', async () => {
    const api = fakeApi({
      saveSound: vi.fn(async () => {
        throw new ApiError(400, 'invalid_config', '設定に問題があります', ['slots.correct: 素材「media-pinpon」が存在しません', 'effectVolume: 0〜1 の数で指定してください'])
      }),
    })
    render(<ChatDeductionSoundCard api={api} loadMedia={loadMedia} />)

    await userEvent.selectOptions(await screen.findByLabelText(CORRECT_LABEL), 'media-pinpon')
    await userEvent.click(screen.getByRole('button', { name: '音を保存する' }))

    expect(await screen.findByText(/・正解（正解の解答が出たとき）: 素材「media-pinpon」が存在しません/)).toBeInTheDocument()
    expect(screen.getByText(/・効果音の音量: 0〜1 の数で指定してください/)).toBeInTheDocument()
  })

  test('設定を読めなければ、選択欄を出さずに理由を出す', async () => {
    const api = fakeApi({
      sound: vi.fn(async () => {
        throw new Error('Workerにつながりません')
      }),
    })
    render(<ChatDeductionSoundCard api={api} loadMedia={loadMedia} />)

    expect(await screen.findByText('Workerにつながりません')).toBeInTheDocument()
    expect(screen.queryByLabelText(BGM_LABEL)).not.toBeInTheDocument()
  })

  test('素材の一覧を読めなければ、選択欄を出さずに理由を出す（選べる音が無いように見せない）', async () => {
    const failingMedia = vi.fn(async (): Promise<MediaItem[]> => {
      throw new Error('素材の一覧を読めません')
    })
    render(<ChatDeductionSoundCard api={fakeApi()} loadMedia={failingMedia} />)

    expect(await screen.findByText('素材の一覧を読めません')).toBeInTheDocument()
    expect(screen.queryByLabelText(BGM_LABEL)).not.toBeInTheDocument()
  })
})
