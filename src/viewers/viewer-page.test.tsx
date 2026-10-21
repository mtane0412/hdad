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
 * - 人形の所持数を組ごとに出し、いまの人形を手で渡す・取り上げられること（issue #418）
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { DollApi } from '@/dolls/api'
import type { DollHolding, DollSet } from '@/dolls/doll'
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

/** いまの人形（クマ）と、前に使った人形（ネコ） */
const bears: DollSet = {
  id: 1,
  normal: { name: 'クマ人形', mediaId: 'image-bear' },
  super: { name: 'スーパークマ人形', mediaId: 'image-super-bear' },
  current: true,
  updatedAt: '2026-10-21T12:00:00.000Z',
}
const cats: DollSet = { ...bears, id: 2, normal: { name: 'ネコ人形', mediaId: 'image-cat' }, super: { name: 'スーパーネコ人形', mediaId: 'image-super-cat' }, current: false }

/**
 * 人形の代役。花子はクマ人形を2つ、前に使ったネコのスーパー人形を1つ持っている。
 * 増減は送られた数をそのまま足したことにする
 */
const createFakeDollApi = (sets: DollSet[] = [bears, cats], overrides: Partial<DollApi> = {}): DollApi => {
  const holdings: DollHolding[] = [
    { userId: '100', setId: 1, normal: 2, super: 0 },
    { userId: '100', setId: 2, normal: 0, super: 1 },
  ]
  return {
    list: vi.fn(async () => ({ sets, holdings })),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    selectCurrent: vi.fn(),
    change: vi.fn(async (userId: string, kind: 'normal' | 'super', delta: number) => {
      const current = holdings.find((holding) => holding.userId === userId && holding.setId === 1) ?? { userId, setId: 1, normal: 0, super: 0 }
      return { ...current, [kind]: current[kind] + delta }
    }),
    prize: vi.fn(),
    savePrize: vi.fn(),
    ...overrides,
  }
}

/** 操作の結果のお知らせ。役割ではなく文言で探す */
/**
 * その人の行を開く。一覧はふだん1人1行の要約で並び、行（表示名から始まるボタン）を押したときだけ、
 * その場で下に人物像・メモ欄・削除のボタンが開く
 */
const openViewer = async (displayName: string): Promise<void> => {
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(`^${displayName}`), expanded: false }))
}

const findNotice = (text: string): Promise<HTMLElement> => screen.findByText(new RegExp(text))

afterEach(cleanup)

describe('視聴者の一覧', () => {
  test('記録のある人の表示名・ログイン名・発言数を一覧に出す', async () => {
    render(<ViewerPage dollApi={createFakeDollApi()} api={createFakeApi()} />)

    const list = await screen.findByRole('list', { name: '視聴者の一覧' })
    expect(within(list).getByText('花子')).toBeInTheDocument()
    expect(within(list).getByText(/hanako/)).toBeInTheDocument()
    expect(within(list).getByText(/42/)).toBeInTheDocument()
  })

  test('行に、発言回数を数と単位で、最後の発言の日時を出し、メモ欄は開くまで出さない', async () => {
    render(<ViewerPage dollApi={createFakeDollApi()} api={createFakeApi()} />)

    const row = within((await screen.findByText('花子')).closest('li') as HTMLElement)
    expect(row.getByText('42')).toBeInTheDocument()
    expect(row.getByText('回')).toBeInTheDocument()
    expect(row.getByText('@hanako').tagName).toBe('CODE')
    expect(row.queryByRole('textbox', { name: '花子 へのメモ' })).not.toBeInTheDocument()
  })

  test('メモを書いてある人の行には「メモあり」を出す（開かなくても分かるようにする）', async () => {
    render(<ViewerPage dollApi={createFakeDollApi()} api={createFakeApi()} />)

    expect(within((await screen.findByText('花子')).closest('li') as HTMLElement).getByText('メモあり')).toBeInTheDocument()
    expect(within(screen.getByText('太郎').closest('li') as HTMLElement).queryByText('メモあり')).not.toBeInTheDocument()
  })

  test('記録が1件もなければ、その旨を出す', async () => {
    render(<ViewerPage dollApi={createFakeDollApi()} api={createFakeApi({ list: vi.fn(async () => []) })} />)

    expect(await screen.findByText(/まだありません/)).toBeInTheDocument()
  })

  test('一覧の取得に失敗したら、理由を出す（黙って空の一覧にしない）', async () => {
    const api = createFakeApi({
      list: vi.fn(async () => {
        throw new Error('Workerが応答しません')
      }),
    })
    render(<ViewerPage dollApi={createFakeDollApi()} api={api} />)

    expect(await screen.findByText(/Workerが応答しません/)).toBeInTheDocument()
  })
})

describe('検索', () => {
  test('入力した語で絞り込んで取得し直す', async () => {
    const api = createFakeApi()
    render(<ViewerPage dollApi={createFakeDollApi()} api={api} />)
    await screen.findByRole('list', { name: '視聴者の一覧' })

    await userEvent.type(screen.getByRole('searchbox', { name: 'ログイン名で検索' }), 'hana')
    await userEvent.click(screen.getByRole('button', { name: '検索' }))

    expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'hana' }))
  })
})

describe('アイコンだけのボタン', () => {
  test('検索と削除は文字を出さず、名前は読み上げとホバー（title）に残す', async () => {
    render(<ViewerPage dollApi={createFakeDollApi()} api={createFakeApi()} />)
    await screen.findByRole('list', { name: '視聴者の一覧' })
    await openViewer('花子')

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
    render(<ViewerPage dollApi={createFakeDollApi()} api={api} />)
    await screen.findByRole('list', { name: '視聴者の一覧' })
    await openViewer('花子')

    const memoInput = screen.getByRole('textbox', { name: '花子 へのメモ' })
    await userEvent.clear(memoInput)
    await userEvent.type(memoInput, '常連さん')
    await userEvent.click(screen.getByRole('button', { name: '花子 のメモを保存する' }))

    expect(api.saveNote).toHaveBeenCalledWith('100', '常連さん')
    expect(await findNotice('メモを保存しました')).toBeInTheDocument()
  })

  test('保存に失敗したら、理由を出す', async () => {
    const api = createFakeApi({
      saveNote: vi.fn(async () => {
        throw new Error('メモは2000文字までにしてください')
      }),
    })
    render(<ViewerPage dollApi={createFakeDollApi()} api={api} />)
    await screen.findByRole('list', { name: '視聴者の一覧' })
    await openViewer('花子')
    await userEvent.click(screen.getByRole('button', { name: '花子 のメモを保存する' }))

    expect(await findNotice('2000文字までにしてください')).toBeInTheDocument()
  })

  test('保存したら書きかけを捨て、Workerが整えて返したメモを未保存と取り違えない', async () => {
    // Workerは前後の空白を落として保存し、保存した値を返す
    const api = createFakeApi({ saveNote: vi.fn(async (_userId: string, note: string) => note.trim()) })
    render(<ViewerPage dollApi={createFakeDollApi()} api={api} />)
    await screen.findByRole('list', { name: '視聴者の一覧' })
    await openViewer('花子')

    const memoInput = screen.getByRole('textbox', { name: '花子 へのメモ' })
    await userEvent.clear(memoInput)
    await userEvent.type(memoInput, '常連さん ')
    await userEvent.click(screen.getByRole('button', { name: '花子 のメモを保存する' }))

    expect(await findNotice('メモを保存しました')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '花子 へのメモ' })).toHaveValue('常連さん')
    expect(screen.queryByText('未保存の変更があります')).not.toBeInTheDocument()
  })

  test('保存を待っているあいだに書き足したメモは、保存が終わっても書きかけとして残す', async () => {
    // 保存の応答を、テストが決めた時点まで返さない
    let finishSave: (saved: string) => void = () => undefined
    const api = createFakeApi({ saveNote: vi.fn(() => new Promise<string>((resolve) => (finishSave = resolve))) })
    render(<ViewerPage dollApi={createFakeDollApi()} api={api} />)
    await screen.findByRole('list', { name: '視聴者の一覧' })
    await openViewer('花子')
    const memoInput = screen.getByRole('textbox', { name: '花子 へのメモ' })
    await userEvent.clear(memoInput)
    await userEvent.type(memoInput, '常連さん')
    await userEvent.click(screen.getByRole('button', { name: '花子 のメモを保存する' }))

    // 保存を待っているあいだに書き足し、そのあと保存が終わる
    await userEvent.type(memoInput, '。歌が好き')
    finishSave('常連さん')

    expect(await findNotice('メモを保存しました')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '花子 へのメモ' })).toHaveValue('常連さん。歌が好き')
    expect(screen.getByText('未保存の変更があります')).toBeInTheDocument()
  })

  test('書いたメモを保存していないあいだは、保存のボタンの横と閉じた行に印を出す', async () => {
    render(<ViewerPage dollApi={createFakeDollApi()} api={createFakeApi()} />)
    await screen.findByRole('list', { name: '視聴者の一覧' })
    await openViewer('花子')
    expect(screen.queryByText('未保存の変更があります')).not.toBeInTheDocument()

    await userEvent.type(screen.getByRole('textbox', { name: '花子 へのメモ' }), '！')
    expect(screen.getByText('未保存の変更があります').closest('[data-tone]')).toHaveAttribute('data-tone', 'attention')

    // 行を閉じても、書きかけがあることを行に残す
    await userEvent.click(screen.getByRole('button', { name: /^花子/, expanded: true }))
    const row = within((await screen.findByText('花子')).closest('li') as HTMLElement)
    expect(row.getByText('未保存').closest('[data-tone]')).toHaveAttribute('data-tone', 'attention')
  })
})

describe('続きの読み込み', () => {
  /** 一度に読む件数（50件）ちょうどを返す。まだ続きがある状態を作るため */
  const fiftyViewers = Array.from({ length: 50 }, (_, index) => ({ ...taro, userId: String(1000 + index), login: `taro${index}`, displayName: `太郎${index}` }))

  test('続きがあるときだけ「もっと読み込む」を出し、最後の人より前を取りに行く', async () => {
    const api = createFakeApi({ list: vi.fn(async () => fiftyViewers) })
    render(<ViewerPage dollApi={createFakeDollApi()} api={api} />)
    await screen.findByRole('list', { name: '視聴者の一覧' })

    await userEvent.click(screen.getByRole('button', { name: 'もっと読み込む' }))

    expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ before: taro.lastSeenAt, beforeUserId: '1049' }))
  })

  test('続きが無ければ「もっと読み込む」を出さない', async () => {
    render(<ViewerPage dollApi={createFakeDollApi()} api={createFakeApi()} />)
    await screen.findByRole('list', { name: '視聴者の一覧' })

    expect(screen.queryByRole('button', { name: 'もっと読み込む' })).not.toBeInTheDocument()
  })
})

describe('記録の削除', () => {
  test('確認してから消し、一覧から外す', async () => {
    const api = createFakeApi()
    render(<ViewerPage dollApi={createFakeDollApi()} api={api} />)
    await screen.findByRole('list', { name: '視聴者の一覧' })
    await openViewer('花子')

    await userEvent.click(screen.getByRole('button', { name: '花子 の記録を削除' }))
    await userEvent.click(await screen.findByRole('button', { name: '削除する' }))

    expect(api.remove).toHaveBeenCalledWith('100')
    const list = await screen.findByRole('list', { name: '視聴者の一覧' })
    expect(within(list).queryByText('花子')).not.toBeInTheDocument()
  })

  test('確認でやめたら消さない', async () => {
    const api = createFakeApi()
    render(<ViewerPage dollApi={createFakeDollApi()} api={api} />)
    await screen.findByRole('list', { name: '視聴者の一覧' })
    await openViewer('花子')

    await userEvent.click(screen.getByRole('button', { name: '花子 の記録を削除' }))
    await userEvent.click(await screen.findByRole('button', { name: 'やめる' }))

    expect(api.remove).not.toHaveBeenCalled()
  })
})

describe('人物像', () => {
  test('LLMが作った人物像を、配信者が書いたメモとは分けて出す', async () => {
    render(<ViewerPage dollApi={createFakeDollApi()} api={createFakeApi()} />)
    await openViewer('花子')

    expect(await screen.findByText('ギターの話をよくする常連さん')).toBeInTheDocument()
    // 人が書いたものと混ざらないよう、機械の推測であることを添える
    expect(screen.getByText(/AIによる人物像/)).toBeInTheDocument()
  })

  test('人物像をまだ作っていない人には、何も出さない', async () => {
    render(<ViewerPage dollApi={createFakeDollApi()} api={createFakeApi({ list: vi.fn(async () => [taro]) })} />)

    await screen.findByText('太郎')
    expect(screen.queryByText(/AIによる人物像/)).not.toBeInTheDocument()
  })
})

describe('その人自身のチャンネル', () => {
  test('観測したカテゴリとタイトルを出す（相手も配信者だと分かるようにするため）', async () => {
    render(<ViewerPage dollApi={createFakeDollApi()} api={createFakeApi()} />)

    const list = await screen.findByRole('list', { name: '視聴者の一覧' })
    expect(within(list).getByText(/Cuphead/)).toBeInTheDocument()
    expect(within(list).getByText(/初見でボスラッシュ/)).toBeInTheDocument()
  })

  test('調べたが配信した記録が無い人には、配信していないようだと出す', async () => {
    const nonStreamer: Viewer = { ...taro, channel: { categoryName: '', title: '', checkedAt: '2026-09-21T13:00:00.000Z' } }
    render(<ViewerPage dollApi={createFakeDollApi()} api={createFakeApi({ list: vi.fn(async () => [nonStreamer]) })} />)

    const list = await screen.findByRole('list', { name: '視聴者の一覧' })
    expect(within(list).getByText(/配信していないようです/)).toBeInTheDocument()
  })

  test('まだ調べていない人には何も出さない（配信していないと決めつけないため）', async () => {
    render(<ViewerPage dollApi={createFakeDollApi()} api={createFakeApi({ list: vi.fn(async () => [taro]) })} />)

    const list = await screen.findByRole('list', { name: '視聴者の一覧' })
    expect(within(list).queryByText(/配信していないようです/)).not.toBeInTheDocument()
    expect(within(list).queryByText(/自分でも配信/)).not.toBeInTheDocument()
  })
})

describe('人形', () => {
  test('いまの人形と、前に使った人形の所持数を出す', async () => {
    render(<ViewerPage dollApi={createFakeDollApi()} api={createFakeApi()} />)
    await openViewer('花子')

    const dolls = within(await screen.findByRole('group', { name: '花子 の人形' }))
    // いまの人形は種類ごとに1行で、名前と数を出す
    expect(dolls.getByRole('listitem', { name: 'クマ人形' })).toHaveTextContent(/2つ$/)
    expect(dolls.getByRole('listitem', { name: 'スーパークマ人形' })).toHaveTextContent(/0つ$/)
    expect(dolls.getByText(/スーパーネコ人形 1つ/)).toBeInTheDocument()
  })

  test('いまの人形を手で渡し、渡したあとの数を出す', async () => {
    const dollApi = createFakeDollApi()
    render(<ViewerPage dollApi={dollApi} api={createFakeApi()} />)
    await openViewer('花子')

    await userEvent.click(await screen.findByRole('button', { name: '花子 にスーパークマ人形を1つ渡す' }))

    expect(dollApi.change).toHaveBeenCalledWith('100', 'super', 1)
    expect(await screen.findByRole('listitem', { name: 'スーパークマ人形' })).toHaveTextContent(/1つ$/)
  })

  test('取り上げは持っている種類だけ押せる', async () => {
    const dollApi = createFakeDollApi()
    render(<ViewerPage dollApi={dollApi} api={createFakeApi()} />)
    await openViewer('花子')

    expect(await screen.findByRole('button', { name: '花子 からスーパークマ人形を1つ取り上げる' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '花子 からクマ人形を1つ取り上げる' }))

    expect(dollApi.change).toHaveBeenCalledWith('100', 'normal', -1)
    expect(await screen.findByRole('listitem', { name: 'クマ人形' })).toHaveTextContent(/1つ$/)
  })

  test('いまの人形が選ばれていなければ、渡すボタンを出さずにその旨を出す', async () => {
    render(<ViewerPage dollApi={createFakeDollApi([{ ...bears, current: false }])} api={createFakeApi()} />)
    await openViewer('花子')

    const dolls = within(await screen.findByRole('group', { name: '花子 の人形' }))
    expect(dolls.getByText(/いまの人形が選ばれていません/)).toBeInTheDocument()
    expect(dolls.queryByRole('button', { name: /渡す$/ })).not.toBeInTheDocument()
  })

  test('人形を読み込めなかったら、理由を出す', async () => {
    render(<ViewerPage dollApi={createFakeDollApi([], { list: vi.fn(async () => Promise.reject(new Error('人形の一覧を読めませんでした'))) })} api={createFakeApi()} />)

    expect(await screen.findByText(/人形の一覧を読めませんでした/)).toBeInTheDocument()
  })
})
