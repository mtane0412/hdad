// @vitest-environment jsdom
/**
 * チャットで推理のページ（/chat-deduction/）のテスト
 *
 * 確かめること（issue #375）:
 * - 報酬がまだ無ければ、作れること。作るまではゲームを始めさせないこと
 * - 報酬があれば、作ってあることと、必要ポイントなどを変えるページへの行き先を出すこと
 * - 問題を区分と正解つきで選び、ゲームを始められること
 * - 開催中は、出している問題を出し、確かめてから終えられること
 * - Worker が断った理由（報酬を切り替えられなかったなど）と、読み込めなかった理由を黙らずに出すこと
 * - 場面ごとに鳴らす音を選ぶカードを出すこと（カードの中身は sound-card.test.tsx が確かめる）
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '@/core/api'
import type { ChatDeductionApi, ChatDeductionGame, ChatDeductionState } from './api'
import { ChatDeductionPage } from './chat-deduction-page'
import type { ChatDeductionProblem } from './problems'
import type { MediaItem } from '@/admin/api'

afterEach(cleanup)

const problems: readonly ChatDeductionProblem[] = [
  { id: 'mount-fuji', category: 'place', answer: '富士山', aliases: ['富士山'], facts: ['日本でいちばん高い山。'] },
  { id: 'natsume-soseki', category: 'person', answer: '夏目漱石', aliases: ['夏目漱石'], facts: ['明治の小説家。'] },
]

const rewards = { questionRewardId: '報酬ID-質問', answerRewardId: '報酬ID-解答' }
const openGame: ChatDeductionGame = { id: 3, problemId: 'natsume-soseki', startedAt: '2026-10-15T12:00:00.000Z', endedAt: null, endReason: null }

/** 操作を記録する代役 */
const createApi = (initial: ChatDeductionState, overrides: Partial<ChatDeductionApi> = {}): ChatDeductionApi => ({
  read: vi.fn(async () => initial),
  createRewards: vi.fn(async () => rewards),
  startGame: vi.fn(async (problemId: string) => ({ ...openGame, problemId })),
  endGame: vi.fn(async (id: number) => ({ ...openGame, id, endedAt: '2026-10-15T12:10:00.000Z', endReason: 'stopped' as const })),
  sound: vi.fn(async () => ({ slots: { bgm: null, start: null, answered: null, wrong: null, correct: null, stopped: null }, bgmVolume: 0.2, effectVolume: 0.6 })),
  saveSound: vi.fn(),
  ...overrides,
})

/** アップロード済みの素材は無い */
const loadMedia = vi.fn(async (): Promise<MediaItem[]> => [])

describe('音', () => {
  test('場面ごとに鳴らす音を選ぶカードを出す', async () => {
    render(<ChatDeductionPage api={createApi({ rewards, game: null })} problems={problems} loadMedia={loadMedia} />)

    expect(await screen.findByLabelText('BGM（ゲームを始めてから、正解か打ち切りまで流す）')).toHaveValue('')
  })
})

describe('報酬', () => {
  test('報酬がまだ無ければ作れる。作るまではゲームを始めさせない', async () => {
    const api = createApi({ rewards: null, game: null })
    render(<ChatDeductionPage api={api} problems={problems} loadMedia={loadMedia} />)

    expect(await screen.findByRole('button', { name: 'ゲームを始める' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '報酬を作る' }))

    expect(api.createRewards).toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: 'ゲームを始める' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '報酬を作る' })).not.toBeInTheDocument()
  })

  test('報酬があれば、作ってあることと、必要ポイントなどを変えるページへの行き先を出す', async () => {
    render(<ChatDeductionPage api={createApi({ rewards, game: null })} problems={problems} loadMedia={loadMedia} />)

    expect(await screen.findByRole('link', { name: 'チャンネルポイント報酬' })).toHaveAttribute('href', '/rewards/')
    expect(screen.queryByRole('button', { name: '報酬を作る' })).not.toBeInTheDocument()
  })
})

describe('ゲーム', () => {
  test('問題を区分と正解つきで選び、ゲームを始められる', async () => {
    const api = createApi({ rewards, game: null })
    render(<ChatDeductionPage api={api} problems={problems} loadMedia={loadMedia} />)

    const select = await screen.findByRole('combobox', { name: '問題' })
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['【場所】富士山', '【人物】夏目漱石'])
    await userEvent.selectOptions(select, 'natsume-soseki')
    await userEvent.click(screen.getByRole('button', { name: 'ゲームを始める' }))

    expect(api.startGame).toHaveBeenCalledWith('natsume-soseki')
    expect(await screen.findByText('【人物】夏目漱石')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '終える' })).toBeInTheDocument()
  })

  test('開催中は出している問題を出し、確かめてから終えられる', async () => {
    const api = createApi({ rewards, game: openGame })
    render(<ChatDeductionPage api={api} problems={problems} loadMedia={loadMedia} />)

    expect(await screen.findByText('【人物】夏目漱石')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '終える' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'ゲームを終える' }))

    expect(api.endGame).toHaveBeenCalledWith(3)
    expect(await screen.findByRole('button', { name: 'ゲームを始める' })).toBeInTheDocument()
  })

  test('Worker が断った理由を出す', async () => {
    const rejected = new ApiError(502, 'chat-deduction-rewards-failed', '報酬を交換できるようにできなかったので、ゲームを始めませんでした', [])
    render(<ChatDeductionPage api={createApi({ rewards, game: null }, { startGame: vi.fn(async () => Promise.reject(rejected)) })} problems={problems} loadMedia={loadMedia} />)

    await userEvent.click(await screen.findByRole('button', { name: 'ゲームを始める' }))

    expect(await screen.findByText(/ゲームを始めませんでした/)).toBeInTheDocument()
  })

  test('開催中のゲームの問題が問題集に無ければ、IDのまま出す（消した問題でも終えられるように）', async () => {
    render(<ChatDeductionPage api={createApi({ rewards, game: { ...openGame, problemId: 'removed-problem' } })} problems={problems} loadMedia={loadMedia} />)

    expect(await screen.findByText('問題集に無い問題（removed-problem）')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '終える' })).toBeInTheDocument()
  })
})

test('読み込めなければ理由を出す', async () => {
  render(<ChatDeductionPage api={createApi({ rewards: null, game: null }, { read: vi.fn(async () => Promise.reject(new Error('通信に失敗しました'))) })} problems={problems} loadMedia={loadMedia} />)

  expect(await screen.findByText('通信に失敗しました')).toBeInTheDocument()
})
