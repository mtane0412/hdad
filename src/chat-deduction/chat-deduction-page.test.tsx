// @vitest-environment jsdom
/**
 * チャットで推理のページ（/chat-deduction/）のテスト
 *
 * 確かめること（issue #375）:
 * - 報酬がまだ無ければ、作れること。作るまではゲームを始めさせないこと
 * - 報酬があれば、作ってあることと、必要ポイントなどを変えるページへの行き先を出すこと
 * - 問題集を選んでゲームを始められること。どの問題かは Worker が決め、正解はこのページにも出さないこと（配信者も一緒に推理するため）
 * - 開催中は、出している問題集と区分だけを出し、確かめてから終えられること。終えたら正解を知らせること
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
import type { ChatDeductionProblemSet } from './problems'
import type { MediaItem } from '@/admin/api'

afterEach(cleanup)

const problemSets: readonly ChatDeductionProblemSet[] = [
  {
    id: 'ancient-people',
    name: '古代史の人物',
    problems: [
      { id: 'himiko', category: 'person', answer: '卑弥呼', aliases: ['卑弥呼'], facts: ['3世紀前半の倭の女王。'] },
      { id: 'kukai', category: 'person', answer: '空海', aliases: ['空海'], facts: ['平安時代前期の僧。'] },
    ],
  },
  { id: 'misc', name: 'いろいろ', problems: [{ id: 'mount-fuji', category: 'place', answer: '富士山', aliases: ['富士山'], facts: ['日本でいちばん高い山。'] }] },
]

const rewards = { questionRewardId: '報酬ID-質問', answerRewardId: '報酬ID-解答' }
const openGame: ChatDeductionGame = { id: 3, problemId: 'kukai', startedAt: '2026-10-15T12:00:00.000Z', endedAt: null, endReason: null }

/** 操作を記録する代役 */
const createApi = (initial: ChatDeductionState, overrides: Partial<ChatDeductionApi> = {}): ChatDeductionApi => ({
  read: vi.fn(async () => initial),
  createRewards: vi.fn(async () => rewards),
  // Worker は問題集の中から問題を決める（ここでは「古代史の人物」なら卑弥呼、ほかは富士山）
  startGame: vi.fn(async (setId: string) => ({ ...openGame, problemId: setId === 'ancient-people' ? 'himiko' : 'mount-fuji' })),
  endGame: vi.fn(async (id: number) => ({ ...openGame, id, endedAt: '2026-10-15T12:10:00.000Z', endReason: 'stopped' as const })),
  sound: vi.fn(async () => ({ slots: { bgm: null, start: null, answered: null, wrong: null, correct: null, stopped: null }, bgmVolume: 0.2, effectVolume: 0.6 })),
  saveSound: vi.fn(),
  ...overrides,
})

/** アップロード済みの素材は無い */
const loadMedia = vi.fn(async (): Promise<MediaItem[]> => [])

describe('音', () => {
  test('場面ごとに鳴らす音を選ぶカードを出す', async () => {
    render(<ChatDeductionPage api={createApi({ rewards, game: null })} problemSets={problemSets} loadMedia={loadMedia} />)

    expect(await screen.findByLabelText('BGM（ゲームを始めてから、正解か打ち切りまで流す）')).toHaveValue('')
  })
})

describe('報酬', () => {
  test('報酬がまだ無ければ作れる。作るまではゲームを始めさせない', async () => {
    const api = createApi({ rewards: null, game: null })
    render(<ChatDeductionPage api={api} problemSets={problemSets} loadMedia={loadMedia} />)

    expect(await screen.findByRole('button', { name: 'ゲームを始める' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '報酬を作る' }))

    expect(api.createRewards).toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: 'ゲームを始める' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '報酬を作る' })).not.toBeInTheDocument()
  })

  test('報酬があれば、作ってあることと、必要ポイントなどを変えるページへの行き先を出す', async () => {
    render(<ChatDeductionPage api={createApi({ rewards, game: null })} problemSets={problemSets} loadMedia={loadMedia} />)

    expect(await screen.findByRole('link', { name: 'チャンネルポイント報酬' })).toHaveAttribute('href', '/rewards/')
    expect(screen.queryByRole('button', { name: '報酬を作る' })).not.toBeInTheDocument()
  })
})

describe('ゲーム', () => {
  test('問題集を問題の数つきで選んでゲームを始められる。決まった問題の正解は出さない', async () => {
    const api = createApi({ rewards, game: null })
    render(<ChatDeductionPage api={api} problemSets={problemSets} loadMedia={loadMedia} />)

    const select = await screen.findByRole('combobox', { name: '問題集' })
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['古代史の人物（2問）', 'いろいろ（1問）'])
    await userEvent.selectOptions(select, 'misc')
    await userEvent.click(screen.getByRole('button', { name: 'ゲームを始める' }))

    expect(api.startGame).toHaveBeenCalledWith('misc')
    expect(await screen.findByText('【場所】いろいろ')).toBeInTheDocument()
    expect(screen.queryByText(/富士山/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '終える' })).toBeInTheDocument()
  })

  test('開催中は問題集と区分だけを出し、確かめてから終えられる。終えたら正解を知らせる', async () => {
    const api = createApi({ rewards, game: openGame })
    render(<ChatDeductionPage api={api} problemSets={problemSets} loadMedia={loadMedia} />)

    expect(await screen.findByText('【人物】古代史の人物')).toBeInTheDocument()
    expect(screen.queryByText(/空海/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '終える' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'ゲームを終える' }))

    expect(api.endGame).toHaveBeenCalledWith(3)
    expect(await screen.findByText('ゲームを終えました（正解は空海でした）')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'ゲームを始める' })).toBeInTheDocument()
  })

  test('Worker が断った理由を出す', async () => {
    const rejected = new ApiError(502, 'chat-deduction-rewards-failed', '報酬を交換できるようにできなかったので、ゲームを始めませんでした', [])
    render(<ChatDeductionPage api={createApi({ rewards, game: null }, { startGame: vi.fn(async () => Promise.reject(rejected)) })} problemSets={problemSets} loadMedia={loadMedia} />)

    await userEvent.click(await screen.findByRole('button', { name: 'ゲームを始める' }))

    expect(await screen.findByText(/ゲームを始めませんでした/)).toBeInTheDocument()
  })

  test('開催中のゲームの問題が問題集に無ければ、IDのまま出す（消した問題でも終えられるように）', async () => {
    render(<ChatDeductionPage api={createApi({ rewards, game: { ...openGame, problemId: 'removed-problem' } })} problemSets={problemSets} loadMedia={loadMedia} />)

    expect(await screen.findByText('問題集に無い問題（removed-problem）')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '終える' })).toBeInTheDocument()
  })
})

test('読み込めなければ理由を出す', async () => {
  render(<ChatDeductionPage api={createApi({ rewards: null, game: null }, { read: vi.fn(async () => Promise.reject(new Error('通信に失敗しました'))) })} problemSets={problemSets} loadMedia={loadMedia} />)

  expect(await screen.findByText('通信に失敗しました')).toBeInTheDocument()
})
