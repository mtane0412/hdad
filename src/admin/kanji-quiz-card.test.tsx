// @vitest-environment jsdom
/**
 * 漢字クイズのカード（音の設定と試し再生）のテスト
 *
 * 確かめること:
 * - 枠（BGM・出題・カウントダウン・正解・時間切れ）ごとに選べるのはアップロード済みの音声と「鳴らさない」だけで、保存してある音が選ばれていること
 * - 選んだ音と音量をWorkerへ送って保存し、保存したことを知らせること
 * - 保存を断られたら、問題点を枠の名前に読み替えて1行ずつ出すこと
 * - 設定を読めなければ、選択欄を出さずに理由を出すこと
 * - 未保存の変更があるあいだは試し再生を押せないこと（試し再生は保存済みの音で鳴るため）
 * （試し再生そのものは trigger-page.test.tsx が確かめる）
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '@/core/api'
import type { KanjiQuizSound } from '@/kanji-quiz/sound'
import type { MediaItem } from './api'
import { KanjiQuizCard, type KanjiQuizApi } from './kanji-quiz-card'

/** アップロード済みの素材。考える曲と正解の音は音声、拍手の動画はアラート用 */
const thinkingBgm: MediaItem = { id: 'media-thinking', name: '考え中.mp3', kind: 'audio', contentType: 'audio/mpeg', size: 3 * 1024 * 1024, uploadedAt: '2026-10-01T00:00:00Z' }
const pinponSound: MediaItem = { id: 'media-pinpon', name: 'ピンポン.mp3', kind: 'audio', contentType: 'audio/mpeg', size: 40 * 1024, uploadedAt: '2026-10-02T00:00:00Z' }
const applauseVideo: MediaItem = { id: 'media-hakushu', name: '拍手.webm', kind: 'video', contentType: 'video/webm', size: 2 * 1024 * 1024, uploadedAt: '2026-09-01T00:00:00Z' }
const media = [thinkingBgm, pinponSound, applauseVideo]

/** BGM に考える曲を選んで保存してある設定 */
const savedSound: KanjiQuizSound = {
  slots: { bgm: 'media-thinking', start: null, countdown: null, correct: null, timeUp: null },
  bgmVolume: 0.3,
  effectVolume: 0.6,
}

const fakeApi = (overrides: Partial<KanjiQuizApi> = {}): KanjiQuizApi => ({
  kanjiQuizSound: vi.fn(async () => savedSound),
  saveKanjiQuizSound: vi.fn(async (sound: KanjiQuizSound) => sound),
  playKanjiQuizDemo: vi.fn(async () => '漢検6級「境内」'),
  ...overrides,
})

const BGM_LABEL = 'BGM（級が出てから、正解か時間切れまで流す）'
const CORRECT_LABEL = '正解（正解者が出たとき）'

afterEach(cleanup)

describe('KanjiQuizCard', () => {
  test('枠ごとに選べるのは「鳴らさない」とアップロード済みの音声だけで、保存してある音が選ばれている', async () => {
    render(<KanjiQuizCard api={fakeApi()} media={media} />)

    const select = await screen.findByLabelText(BGM_LABEL)
    expect(select).toHaveValue('media-thinking')
    expect(screen.getByLabelText(CORRECT_LABEL)).toHaveValue('')
    const options = within(select).getAllByRole('option').map((option) => option.textContent)
    expect(options).toEqual(['鳴らさない', '考え中.mp3', 'ピンポン.mp3'])
  })

  test('正解の音を選んで保存すると、選んだ音と音量をWorkerへ送り、保存したことを知らせる', async () => {
    const api = fakeApi()
    render(<KanjiQuizCard api={api} media={media} />)

    await userEvent.selectOptions(await screen.findByLabelText(CORRECT_LABEL), 'media-pinpon')
    expect(screen.getByText('未保存の変更があります')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '音を保存' }))

    expect(api.saveKanjiQuizSound).toHaveBeenCalledWith({ ...savedSound, slots: { ...savedSound.slots, correct: 'media-pinpon' } })
    expect(await screen.findByText('漢字クイズの音を保存しました')).toBeInTheDocument()
    expect(screen.queryByText('未保存の変更があります')).not.toBeInTheDocument()
  })

  test('保存を断られたら、問題点を枠の名前に読み替えて1行ずつ出す', async () => {
    const api = fakeApi({
      saveKanjiQuizSound: vi.fn(async () => {
        throw new ApiError(400, 'invalid_config', '設定に問題があります', ['slots.correct: 素材「media-pinpon」が存在しません', 'effectVolume: 0〜1 の数で指定してください'])
      }),
    })
    render(<KanjiQuizCard api={api} media={media} />)

    await userEvent.selectOptions(await screen.findByLabelText(CORRECT_LABEL), 'media-pinpon')
    await userEvent.click(screen.getByRole('button', { name: '音を保存' }))

    expect(await screen.findByText(/・正解（正解者が出たとき）: 素材「media-pinpon」が存在しません/)).toBeInTheDocument()
    expect(screen.getByText(/・効果音の音量: 0〜1 の数で指定してください/)).toBeInTheDocument()
  })

  test('設定を読めなければ、選択欄を出さずに理由を出す', async () => {
    const api = fakeApi({
      kanjiQuizSound: vi.fn(async () => {
        throw new Error('Workerにつながりません')
      }),
    })
    render(<KanjiQuizCard api={api} media={media} />)

    expect(await screen.findByText('Workerにつながりません')).toBeInTheDocument()
    expect(screen.queryByLabelText(BGM_LABEL)).not.toBeInTheDocument()
  })

  test('未保存の変更があるあいだは試し再生を押せない（試し再生は保存済みの音で鳴り、選び直した音と食い違うため）', async () => {
    render(<KanjiQuizCard api={fakeApi()} media={media} />)

    const playButton = screen.getByRole('button', { name: '漢字クイズを試しに流す' })
    await userEvent.selectOptions(await screen.findByLabelText(CORRECT_LABEL), 'media-pinpon')

    expect(playButton).toBeDisabled()
  })
})
