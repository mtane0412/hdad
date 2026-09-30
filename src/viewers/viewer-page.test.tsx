// @vitest-environment jsdom
/**
 * 視聴者のページ（記録の一覧・検索・メモ・削除）のテスト
 *
 * 確かめること:
 * - 記録のある人の名前・発言数・最後の発言日時を一覧に出すこと
 * - 名前で検索できること
 * - メモを書いて保存できること
 * - 削除は確認してから行うこと
 * - 失敗は黙って無視せず、理由を出すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Viewer, ViewerApi } from './api'
import { ViewerPage } from './viewer-page'

const hanako: Viewer = {
  userId: '100',
  login: 'hanako',
  displayName: '花子',
  firstSeenAt: '2026-09-01T12:00:00.000Z',
  lastSeenAt: '2026-09-21T12:00:00.000Z',
  messageCount: 42,
  badges: ['subscriber'],
  note: 'ゲームの話をよくする人',
  summary: 'ギターの話をよくする常連さん',
  summarizedAt: '2026-09-21T13:00:00.000Z',
  channel: { categoryName: 'Cuphead', title: '初見でボスラッシュ', checkedAt: '2026-09-21T13:00:00.000Z' },
}

const taro: Viewer = {
  userId: '200',
  login: 'taro',
  displayName: '太郎',
  firstSeenAt: '2026-09-10T12:00:00.000Z',
  lastSeenAt: '2026-09-20T12:00:00.000Z',
  messageCount: 3,
  badges: [],
  note: '',
  summary: '',
  summarizedAt: null,
  channel: null,
}

const createFakeApi = (overrides: Partial<ViewerApi> = {}): ViewerApi => ({
  list: vi.fn(async () => [hanako, taro]),
  saveNote: vi.fn(async (_userId: string, note: string) => note),
  remove: vi.fn(async () => {}),
  ...overrides,
})

/** 操作の結果のお知らせ。役割ではなく文言で探す */
const findNotice = (text: string): Promise<HTMLElement> => screen.findByText(new RegExp(text))

afterEach(cleanup)

describe('視聴者の一覧', () => {
  test('記録のある人の表示名・ログイン名・発言数を一覧に出す', async () => {
    render(<ViewerPage api={createFakeApi()} />)

    const list = await screen.findByRole('list', { name: '視聴者の一覧' })
    expect(within(list).getByText('花子')).toBeInTheDocument()
    expect(within(list).getByText(/hanako/)).toBeInTheDocument()
    expect(within(list).getByText(/42/)).toBeInTheDocument()
  })

  test('記録が1件もなければ、その旨を出す', async () => {
    render(<ViewerPage api={createFakeApi({ list: vi.fn(async () => []) })} />)

    expect(await screen.findByText(/まだありません/)).toBeInTheDocument()
  })

  test('一覧の取得に失敗したら、理由を出す（黙って空の一覧にしない）', async () => {
    const api = createFakeApi({
      list: vi.fn(async () => {
        throw new Error('Workerが応答しません')
      }),
    })
    render(<ViewerPage api={api} />)

    expect(await screen.findByText(/Workerが応答しません/)).toBeInTheDocument()
  })
})

describe('検索', () => {
  test('入力した語で絞り込んで取得し直す', async () => {
    const api = createFakeApi()
    render(<ViewerPage api={api} />)
    await screen.findByRole('list', { name: '視聴者の一覧' })

    await userEvent.type(screen.getByRole('searchbox', { name: 'ログイン名で検索' }), 'hana')
    await userEvent.click(screen.getByRole('button', { name: '検索' }))

    expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'hana' }))
  })
})

describe('アイコンだけのボタン', () => {
  test('検索と削除は文字を出さず、名前は読み上げとホバー（title）に残す', async () => {
    render(<ViewerPage api={createFakeApi()} />)
    await screen.findByRole('list', { name: '視聴者の一覧' })

    for (const label of ['検索', '花子 の記録を削除']) {
      const button = screen.getByRole('button', { name: label })
      expect(button).toHaveTextContent('')
      expect(button).toHaveAttribute('title', label)
    }
  })
})

describe('メモ', () => {
  test('書いたメモを保存し、保存したことを知らせる', async () => {
    const api = createFakeApi()
    render(<ViewerPage api={api} />)
    await screen.findByRole('list', { name: '視聴者の一覧' })

    const memoInput = screen.getByRole('textbox', { name: '花子 へのメモ' })
    await userEvent.clear(memoInput)
    await userEvent.type(memoInput, '常連さん')
    await userEvent.click(screen.getByRole('button', { name: '花子 のメモを保存' }))

    expect(api.saveNote).toHaveBeenCalledWith('100', '常連さん')
    expect(await findNotice('メモを保存しました')).toBeInTheDocument()
  })

  test('保存に失敗したら、理由を出す', async () => {
    const api = createFakeApi({
      saveNote: vi.fn(async () => {
        throw new Error('メモは2000文字までにしてください')
      }),
    })
    render(<ViewerPage api={api} />)
    await screen.findByRole('list', { name: '視聴者の一覧' })

    await userEvent.click(screen.getByRole('button', { name: '花子 のメモを保存' }))

    expect(await findNotice('2000文字までにしてください')).toBeInTheDocument()
  })
})

describe('続きの読み込み', () => {
  /** 一度に読む件数（50件）ちょうどを返す。まだ続きがある状態を作るため */
  const fiftyViewers = Array.from({ length: 50 }, (_, index) => ({ ...taro, userId: String(1000 + index), login: `taro${index}`, displayName: `太郎${index}` }))

  test('続きがあるときだけ「もっと読み込む」を出し、最後の人より前を取りに行く', async () => {
    const api = createFakeApi({ list: vi.fn(async () => fiftyViewers) })
    render(<ViewerPage api={api} />)
    await screen.findByRole('list', { name: '視聴者の一覧' })

    await userEvent.click(screen.getByRole('button', { name: 'もっと読み込む' }))

    expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ before: taro.lastSeenAt, beforeUserId: '1049' }))
  })

  test('続きが無ければ「もっと読み込む」を出さない', async () => {
    render(<ViewerPage api={createFakeApi()} />)
    await screen.findByRole('list', { name: '視聴者の一覧' })

    expect(screen.queryByRole('button', { name: 'もっと読み込む' })).not.toBeInTheDocument()
  })
})

describe('記録の削除', () => {
  test('確認してから消し、一覧から外す', async () => {
    const api = createFakeApi()
    render(<ViewerPage api={api} />)
    await screen.findByRole('list', { name: '視聴者の一覧' })

    await userEvent.click(screen.getByRole('button', { name: '花子 の記録を削除' }))
    await userEvent.click(await screen.findByRole('button', { name: '削除する' }))

    expect(api.remove).toHaveBeenCalledWith('100')
    const list = await screen.findByRole('list', { name: '視聴者の一覧' })
    expect(within(list).queryByText('花子')).not.toBeInTheDocument()
  })

  test('確認でやめたら消さない', async () => {
    const api = createFakeApi()
    render(<ViewerPage api={api} />)
    await screen.findByRole('list', { name: '視聴者の一覧' })

    await userEvent.click(screen.getByRole('button', { name: '花子 の記録を削除' }))
    await userEvent.click(await screen.findByRole('button', { name: 'やめる' }))

    expect(api.remove).not.toHaveBeenCalled()
  })
})

describe('人物像', () => {
  test('LLMが作った人物像を、配信者が書いたメモとは分けて出す', async () => {
    render(<ViewerPage api={createFakeApi()} />)

    expect(await screen.findByText('ギターの話をよくする常連さん')).toBeInTheDocument()
    // 人が書いたものと混ざらないよう、機械の推測であることを添える
    expect(screen.getByText(/AIによる人物像/)).toBeInTheDocument()
  })

  test('人物像をまだ作っていない人には、何も出さない', async () => {
    render(<ViewerPage api={createFakeApi({ list: vi.fn(async () => [taro]) })} />)

    await screen.findByText('太郎')
    expect(screen.queryByText(/AIによる人物像/)).not.toBeInTheDocument()
  })
})

describe('その人自身のチャンネル', () => {
  test('観測したカテゴリとタイトルを出す（相手も配信者だと分かるようにするため）', async () => {
    render(<ViewerPage api={createFakeApi()} />)

    const list = await screen.findByRole('list', { name: '視聴者の一覧' })
    expect(within(list).getByText(/Cuphead/)).toBeInTheDocument()
    expect(within(list).getByText(/初見でボスラッシュ/)).toBeInTheDocument()
  })

  test('調べたが配信した記録が無い人には、配信していないようだと出す', async () => {
    const nonStreamer: Viewer = { ...taro, channel: { categoryName: '', title: '', checkedAt: '2026-09-21T13:00:00.000Z' } }
    render(<ViewerPage api={createFakeApi({ list: vi.fn(async () => [nonStreamer]) })} />)

    const list = await screen.findByRole('list', { name: '視聴者の一覧' })
    expect(within(list).getByText(/配信していないようです/)).toBeInTheDocument()
  })

  test('まだ調べていない人には何も出さない（配信していないと決めつけないため）', async () => {
    render(<ViewerPage api={createFakeApi({ list: vi.fn(async () => [taro]) })} />)

    const list = await screen.findByRole('list', { name: '視聴者の一覧' })
    expect(within(list).queryByText(/配信していないようです/)).not.toBeInTheDocument()
    expect(within(list).queryByText(/自分でも配信/)).not.toBeInTheDocument()
  })
})
