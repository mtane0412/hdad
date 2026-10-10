// @vitest-environment jsdom
/**
 * 意見ボードのページ（/opinions/）のテスト
 *
 * 確かめること:
 * - テーマを出していないときは、テーマを入力して出せること（Worker が拒んだ理由は黙らずに出す）
 * - テーマを出しているあいだは、確かめてから締め切れること
 * - 意見を論点ごとに、札の種類・人数・もとのコメントつきで出すこと（人数はこのページにだけ出す）
 * - 意見を隠す・戻すことができ、隠した意見はそれと分かること
 * - 読み込めなかった理由を黙らずに出すこと
 * - 入力しかけのテーマがあるあいだは、ページを離れる前に確認を出すこと（useUnsavedChanges）
 * - テーマを出しているあいだは、いまの問いかけを確かめ、別の問いかけに替えさせられること（issue #307）
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { hasUnsavedChanges } from '@/app/router'
import { ApiError } from '@/core/api'
import type { AdminOpinionBoard, OpinionApi } from './api'
import type { OpinionTheme } from './entry'
import { OpinionPage } from './opinion-page'

afterEach(cleanup)

const openTheme: OpinionTheme = { id: 1, title: '配信中にAIをどこまで使っていい？', openedAt: '2026-10-10T12:00:00.000Z', closedAt: null, prompt: null }

/** テーマを出していて、論点が1つ・意見が2件ある意見ボード */
const board: AdminOpinionBoard = {
  theme: openTheme,
  topics: [
    {
      id: 1,
      title: '視聴者との距離',
      opinions: [
        {
          id: 12,
          kind: 'insight',
          text: '初見さんへの挨拶はAIでも嬉しい',
          author: 'mugi',
          createdAt: '2026-10-10T12:03:00.000Z',
          hidden: false,
          people: 1,
          sources: [{ userName: 'mugi', text: '初見のときAIに挨拶されて嬉しかった' }],
        },
        {
          id: 11,
          kind: 'issue',
          text: 'AIが返事すると距離を感じる',
          author: 'aoi',
          createdAt: '2026-10-10T12:01:00.000Z',
          hidden: true,
          people: 2,
          sources: [
            { userName: 'aoi', text: 'AIのコメ返しはちょっと寂しい' },
            { userName: 'riku', text: 'AIの返事だと距離を感じる' },
          ],
        },
      ],
    },
  ],
}

/** 操作を記録する代役 */
const createApi = (initial: AdminOpinionBoard = board, overrides: Partial<OpinionApi> = {}): OpinionApi => ({
  read: vi.fn(async () => initial),
  openTheme: vi.fn(async (title: string) => ({ ...openTheme, id: 2, title })),
  closeTheme: vi.fn(async (id: number) => ({ ...openTheme, id, closedAt: '2026-10-10T12:30:00.000Z' })),
  setHidden: vi.fn(async () => undefined),
  replacePrompt: vi.fn(async (id: number) => ({ ...openTheme, id, prompt: 'AIの使用料、配信者はどこまで払っていいと思う？' })),
  ...overrides,
})

describe('テーマ', () => {
  test('テーマを出していなければ、入力して出せる', async () => {
    const api = createApi({ theme: null, topics: [] })
    render(<OpinionPage api={api} />)

    await userEvent.type(await screen.findByRole('textbox', { name: 'テーマ' }), '配信中にAIをどこまで使っていい？')
    expect(hasUnsavedChanges()).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'テーマを出す' }))

    expect(api.openTheme).toHaveBeenCalledWith('配信中にAIをどこまで使っていい？')
    expect(await screen.findByText('配信中にAIをどこまで使っていい？')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '締め切る' })).toBeInTheDocument()
    expect(hasUnsavedChanges()).toBe(false)
  })

  test('Worker が拒んだ理由を出す', async () => {
    const rejected = new ApiError(400, 'invalid-config', '意見ボードのテーマに問題があります', ['テーマを入力してください'])
    render(<OpinionPage api={createApi({ theme: null, topics: [] }, { openTheme: vi.fn(async () => Promise.reject(rejected)) })} />)

    await userEvent.click(await screen.findByRole('button', { name: 'テーマを出す' }))

    expect(await screen.findByText(/・テーマを入力してください/)).toBeInTheDocument()
  })

  test('テーマを出しているあいだは、確かめてから締め切れる', async () => {
    const api = createApi()
    render(<OpinionPage api={api} />)

    await userEvent.click(await screen.findByRole('button', { name: '締め切る' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'テーマを締め切る' }))

    expect(api.closeTheme).toHaveBeenCalledWith(1)
    expect(await screen.findByRole('button', { name: 'テーマを出す' })).toBeInTheDocument()
  })
})

describe('問いかけ', () => {
  test('まだ問いかけが無ければ、その旨を出す', async () => {
    render(<OpinionPage api={createApi()} />)
    expect(await screen.findByText(/まだ問いかけはありません/)).toBeInTheDocument()
  })

  test('いまの問いかけを出し、別の問いかけに替えさせられる', async () => {
    const api = createApi({ ...board, theme: { ...openTheme, prompt: 'AIに任せたくない作業はどれ？' } })
    render(<OpinionPage api={api} />)

    const section = await screen.findByRole('group', { name: '視聴者への問いかけ' })
    expect(within(section).getByText('AIに任せたくない作業はどれ？')).toBeInTheDocument()
    await userEvent.click(within(section).getByRole('button', { name: '別の問いかけにする' }))

    expect(api.replacePrompt).toHaveBeenCalledWith(1)
    expect(await within(section).findByText('AIの使用料、配信者はどこまで払っていいと思う？')).toBeInTheDocument()
  })

  test('問いかけを作れなければ理由を出す', async () => {
    const failed = new ApiError(502, 'opinion-prompt-failed', '問いかけを作り直せませんでした。前の問いかけを残しています', [])
    render(<OpinionPage api={createApi(board, { replacePrompt: vi.fn(async () => Promise.reject(failed)) })} />)

    await userEvent.click(await screen.findByRole('button', { name: '別の問いかけにする' }))

    expect(await screen.findByText(/問いかけを作り直せませんでした/)).toBeInTheDocument()
  })

  test('締め切ったテーマでは、問いかけを替えさせない', async () => {
    render(<OpinionPage api={createApi({ ...board, theme: { ...openTheme, closedAt: '2026-10-10T12:30:00.000Z', prompt: 'AIに任せたくない作業はどれ？' } })} />)
    await screen.findByText(/締め切ったテーマ/)
    expect(screen.queryByRole('button', { name: '別の問いかけにする' })).not.toBeInTheDocument()
  })
})

describe('意見', () => {
  test('論点ごとに、札の種類・人数・もとのコメントつきで出す', async () => {
    render(<OpinionPage api={createApi()} />)

    const topic = await screen.findByRole('group', { name: '論点「視聴者との距離」' })
    const opinion = within(topic).getByRole('group', { name: '意見「AIが返事すると距離を感じる」' })
    expect(within(opinion).getByText('課題')).toBeInTheDocument()
    expect(within(opinion).getByText('2人')).toBeInTheDocument()
    expect(within(opinion).getByText('riku: AIの返事だと距離を感じる')).toBeInTheDocument()
  })

  test('隠した意見はそれと分かり、戻せる。隠していない意見は隠せる', async () => {
    const api = createApi()
    render(<OpinionPage api={api} />)

    const hiddenOpinion = await screen.findByRole('group', { name: '意見「AIが返事すると距離を感じる」' })
    expect(within(hiddenOpinion).getByText('隠しています')).toBeInTheDocument()
    await userEvent.click(within(hiddenOpinion).getByRole('button', { name: '戻す' }))
    expect(api.setHidden).toHaveBeenCalledWith(11, false)

    await userEvent.click(within(screen.getByRole('group', { name: '意見「初見さんへの挨拶はAIでも嬉しい」' })).getByRole('button', { name: '隠す' }))
    expect(api.setHidden).toHaveBeenCalledWith(12, true)
    await waitFor(() => expect(within(screen.getByRole('group', { name: '意見「初見さんへの挨拶はAIでも嬉しい」' })).getByText('隠しています')).toBeInTheDocument())
  })

  test('操作の前に始めた読み直しの結果で、操作したあとの表示を古い状態に戻さない', async () => {
    // 2回目の読み直し（15秒後）は、操作のあとで、操作の前の意見ボードを返す
    let resolveStale: (stale: AdminOpinionBoard) => void = () => undefined
    const read = vi
      .fn<OpinionApi['read']>()
      .mockResolvedValueOnce(board)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveStale = resolve)))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const api = createApi(board, { read })
      render(<OpinionPage api={api} />)
      const opinionName = { name: '意見「初見さんへの挨拶はAIでも嬉しい」' }
      await screen.findByRole('group', opinionName)

      // 読み直しを始めさせてから、意見を隠す
      await vi.advanceTimersByTimeAsync(15_000)
      expect(read).toHaveBeenCalledTimes(2)
      await userEvent.click(within(screen.getByRole('group', opinionName)).getByRole('button', { name: '隠す' }))
      await waitFor(() => expect(within(screen.getByRole('group', opinionName)).getByText('隠しています')).toBeInTheDocument())

      // 操作の前に始めた読み直しの結果が届いても、隠したままにする
      await act(async () => {
        resolveStale(board)
        await Promise.resolve()
      })
      expect(within(screen.getByRole('group', opinionName)).getByText('隠しています')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  test('意見がまだ無ければ、その旨を出す', async () => {
    render(<OpinionPage api={createApi({ theme: openTheme, topics: [] })} />)
    expect(await screen.findByText(/まだ意見がありません/)).toBeInTheDocument()
  })

  test('読み込めなければ理由を出す', async () => {
    render(<OpinionPage api={createApi(board, { read: vi.fn(async () => Promise.reject(new Error('Workerにつながりません'))) })} />)
    expect(await screen.findByText('Workerにつながりません')).toBeInTheDocument()
  })
})
