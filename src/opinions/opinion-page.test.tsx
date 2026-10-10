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
 * - コメントの内訳を出し、意見にならなかったコメントを、下書きを直して新しい意見にし・既にある意見に統合できること（issue #308）
 * - 論点の名前を書き換え、確かめてから2つの論点をまとめられること。書きかけのあいだは離れる前に確認を出すこと（issue #308）
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { hasUnsavedChanges } from '@/app/router'
import { ApiError } from '@/core/api'
import type { AdminOpinionBoard, OpinionApi, OpinionCommentCounts, RescuableComment } from './api'
import type { OpinionTheme } from './entry'
import { OpinionPage } from './opinion-page'

afterEach(cleanup)

const openTheme: OpinionTheme = { id: 1, title: '配信中にAIをどこまで使っていい？', openedAt: '2026-10-10T12:00:00.000Z', closedAt: null, prompt: null }

/** コメントを1件も受け取っていない内訳 */
const noCounts: OpinionCommentCounts = { received: 0, used: 0, pending: 0, dropped: { command: 0, emote: 0, reaction: 0 }, filtered: 0, ignored: 0, failed: 0 }

/** 意見にならなかったコメント（LLM が無関係とした） */
const ignoredComment: RescuableComment = {
  id: 7,
  userName: 'mugi',
  text: 'AIの声が人っぽすぎると怖い',
  replyName: null,
  replyText: null,
  sentAt: '2026-10-10T12:04:00.000Z',
  status: 'ignored',
  dropReason: null,
  jevScore: 0.41,
}

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
  counts: { received: 6, used: 3, pending: 0, dropped: { command: 1, emote: 0, reaction: 1 }, filtered: 0, ignored: 1, failed: 0 },
  rescuable: [ignoredComment],
}

/** 操作を記録する代役 */
const createApi = (initial: AdminOpinionBoard = board, overrides: Partial<OpinionApi> = {}): OpinionApi => ({
  read: vi.fn(async () => initial),
  openTheme: vi.fn(async (title: string) => ({ ...openTheme, id: 2, title })),
  closeTheme: vi.fn(async (id: number) => ({ ...openTheme, id, closedAt: '2026-10-10T12:30:00.000Z' })),
  setHidden: vi.fn(async () => undefined),
  replacePrompt: vi.fn(async (id: number) => ({ ...openTheme, id, prompt: 'AIの使用料、配信者はどこまで払っていいと思う？' })),
  draftOpinion: vi.fn(async () => ({ kind: 'insight' as const, text: '人っぽすぎる声は怖い', topic: { type: 'existing' as const, id: 1 } })),
  rescueAsOpinion: vi.fn(async () => undefined),
  joinOpinion: vi.fn(async () => undefined),
  renameTopic: vi.fn(async () => undefined),
  mergeTopics: vi.fn(async () => undefined),
  ...overrides,
})

describe('テーマ', () => {
  test('テーマを出していなければ、入力して出せる', async () => {
    const api = createApi({ theme: null, topics: [], counts: noCounts, rescuable: [] })
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
    render(<OpinionPage api={createApi({ theme: null, topics: [], counts: noCounts, rescuable: [] }, { openTheme: vi.fn(async () => Promise.reject(rejected)) })} />)

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
    render(<OpinionPage api={createApi({ theme: openTheme, topics: [], counts: noCounts, rescuable: [] })} />)
    expect(await screen.findByText(/まだ意見がありません/)).toBeInTheDocument()
  })

  test('読み込めなければ理由を出す', async () => {
    render(<OpinionPage api={createApi(board, { read: vi.fn(async () => Promise.reject(new Error('Workerにつながりません'))) })} />)
    expect(await screen.findByText('Workerにつながりません')).toBeInTheDocument()
  })
})

describe('意見にならなかったコメント（issue #308）', () => {
  test('コメントの内訳を、規則・Jev・LLM・失敗に分けて出す', async () => {
    render(<OpinionPage api={createApi()} />)

    const counts = await screen.findByRole('group', { name: 'コメントの内訳' })
    expect(within(counts).getByText('受け取った: 6件')).toBeInTheDocument()
    expect(within(counts).getByText('意見にした: 3件')).toBeInTheDocument()
    expect(within(counts).getByText('規則で落とした: 2件（コマンド 1・エモートだけ 0・短い反応 1）')).toBeInTheDocument()
    expect(within(counts).getByText('LLM が無関係とした: 1件')).toBeInTheDocument()
  })

  test('下書きを直して、新しい意見にする', async () => {
    const api = createApi()
    render(<OpinionPage api={api} />)

    const item = await screen.findByRole('group', { name: 'コメント「AIの声が人っぽすぎると怖い」' })
    expect(within(item).getByText('LLM が無関係とした')).toBeInTheDocument()
    await userEvent.click(within(item).getByRole('button', { name: '新しい意見にする' }))
    expect(api.draftOpinion).toHaveBeenCalledWith(7)

    // 下書きが入った欄を直す（書きかけのあいだは、離れる前に確認を出す）
    const text = await within(item).findByRole('textbox', { name: '意見' })
    expect(text).toHaveValue('人っぽすぎる声は怖い')
    expect(hasUnsavedChanges()).toBe(true)
    await userEvent.clear(text)
    await userEvent.type(text, 'AIの声が人に似すぎると怖い')
    await userEvent.selectOptions(within(item).getByRole('combobox', { name: '札の種類' }), '課題')
    await userEvent.click(within(item).getByRole('button', { name: '意見にする' }))

    expect(api.rescueAsOpinion).toHaveBeenCalledWith(7, { kind: 'issue', text: 'AIの声が人に似すぎると怖い', topic: { type: 'existing', id: 1 } })
    await waitFor(() => expect(within(item).queryByRole('textbox', { name: '意見' })).not.toBeInTheDocument())
    // 保存したら意見ボードを読み直す
    expect(api.read).toHaveBeenCalledTimes(2)
  })

  test('下書きが新しい論点なら、論点の名前の欄に入れて出す', async () => {
    const api = createApi(board, {
      draftOpinion: vi.fn(async () => ({ kind: 'question' as const, text: 'AIの声は誰の声？', topic: { type: 'new' as const, title: '声と人格' } })),
    })
    render(<OpinionPage api={api} />)

    const item = await screen.findByRole('group', { name: 'コメント「AIの声が人っぽすぎると怖い」' })
    await userEvent.click(within(item).getByRole('button', { name: '新しい意見にする' }))
    expect(await within(item).findByRole('textbox', { name: '新しい論点の名前' })).toHaveValue('声と人格')
    await userEvent.click(within(item).getByRole('button', { name: '意見にする' }))

    expect(api.rescueAsOpinion).toHaveBeenCalledWith(7, { kind: 'question', text: 'AIの声は誰の声？', topic: { type: 'new', title: '声と人格' } })
  })

  test('下書きを作れなければ理由を出す', async () => {
    const failed = new ApiError(502, 'opinion-draft-failed', '意見の下書きを作れませんでした。もう一度試してください', [])
    render(<OpinionPage api={createApi(board, { draftOpinion: vi.fn(async () => Promise.reject(failed)) })} />)

    await userEvent.click(await screen.findByRole('button', { name: '新しい意見にする' }))

    expect(await screen.findByText(/意見の下書きを作れませんでした/)).toBeInTheDocument()
  })

  test('既にある意見に統合する', async () => {
    const api = createApi()
    render(<OpinionPage api={api} />)

    const item = await screen.findByRole('group', { name: 'コメント「AIの声が人っぽすぎると怖い」' })
    await userEvent.click(within(item).getByRole('button', { name: '既にある意見に統合する' }))
    await userEvent.selectOptions(within(item).getByRole('combobox', { name: '統合する意見' }), 'AIが返事すると距離を感じる')
    await userEvent.click(within(item).getByRole('button', { name: '統合する' }))

    expect(api.joinOpinion).toHaveBeenCalledWith(7, 11)
  })

  test('意見にならなかったコメントが無ければ、その旨を出す', async () => {
    render(<OpinionPage api={createApi({ ...board, rescuable: [] })} />)
    expect(await screen.findByText(/意見にならなかったコメントはありません/)).toBeInTheDocument()
  })
})

describe('論点の整理（issue #308）', () => {
  /** 論点が2つある意見ボード */
  const twoTopics: AdminOpinionBoard = {
    ...board,
    topics: [
      ...board.topics,
      {
        id: 2,
        title: '声と人格',
        opinions: [
          {
            id: 13,
            kind: 'question',
            text: 'AIの声は誰の声？',
            author: 'sora',
            createdAt: '2026-10-10T12:05:00.000Z',
            hidden: false,
            people: 1,
            sources: [{ userName: 'sora', text: 'AIの声って誰の声なんだろう' }],
          },
        ],
      },
    ],
  }

  test('論点の名前を書き換える', async () => {
    const api = createApi()
    render(<OpinionPage api={api} />)

    const topic = await screen.findByRole('group', { name: '論点「視聴者との距離」' })
    await userEvent.click(within(topic).getByRole('button', { name: '名前を変える' }))
    const input = within(topic).getByRole('textbox', { name: '論点の名前' })
    expect(input).toHaveValue('視聴者との距離')
    await userEvent.clear(input)
    await userEvent.type(input, 'AIとの距離感')
    await userEvent.click(within(topic).getByRole('button', { name: '名前を保存' }))

    expect(api.renameTopic).toHaveBeenCalledWith(1, 'AIとの距離感')
  })

  test('論点が1つなら、まとめる操作を出さない', async () => {
    render(<OpinionPage api={createApi()} />)
    await screen.findByRole('group', { name: '論点「視聴者との距離」' })
    expect(screen.queryByRole('button', { name: 'ほかの論点とまとめる' })).not.toBeInTheDocument()
  })

  test('確かめてから、2つの論点をまとめる', async () => {
    const api = createApi(twoTopics)
    render(<OpinionPage api={api} />)

    const topic = await screen.findByRole('group', { name: '論点「声と人格」' })
    await userEvent.click(within(topic).getByRole('button', { name: 'ほかの論点とまとめる' }))
    await userEvent.selectOptions(within(topic).getByRole('combobox', { name: 'まとめ先' }), '視聴者との距離')
    await userEvent.click(within(topic).getByRole('button', { name: 'まとめる' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '論点をまとめる' }))

    expect(api.mergeTopics).toHaveBeenCalledWith(2, 1)
  })
})
