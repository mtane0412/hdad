// @vitest-environment jsdom
/**
 * 注目コメントのページ（取り上げるものの指定）のテスト
 *
 * 確かめること:
 * - いま取り上げている1件を、アイコン・名前・本文で出すこと（取り上げていなければその旨）
 * - 直近の発言の一覧から、1件を取り上げられること
 * - 取り上げているものを外せること
 * - 失敗は黙って無視せず、理由を出すこと
 * - 配信画面への出し方は、合成オーバーレイの管理画面（/overlay/）へ案内すること（単独ページを消した issue #107）
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { FocusApi, FocusPick, PickableMessage } from './api'
import type { FocusTarget } from './focused'
import { FocusPage } from './focus-page'

const horrorChat: PickableMessage = {
  messageId: '発言1',
  login: 'kowai_hanashi',
  displayName: '怖い話す人',
  text: '今から怖い話をするね',
  at: '2026-09-27T12:10:00.000Z',
}

const smallTalkChat: PickableMessage = {
  messageId: '発言2',
  login: 'zatsudan_suki',
  displayName: '雑談好き',
  text: 'キーボードは結局どれを買ったんですか？',
  at: '2026-09-27T12:11:00.000Z',
}

const iconUrl = 'https://static-cdn.jtvnw.net/jtv_user_pictures/kowai_hanashi.png'

/** 発言1件を取り上げている状態 */
const focusedChat: FocusTarget = {
  messageId: '発言1',
  login: 'kowai_hanashi',
  displayName: '怖い話す人',
  text: '今から怖い話をするね',
  profileImageUrl: iconUrl,
}

const fakeApi = (overrides: Partial<FocusApi> = {}): FocusApi => ({
  load: vi.fn(async () => null),
  // Worker と同じく、選んだ発言にアイコンを添えて返す
  save: vi.fn(async (pick: FocusPick | null) => (pick === null ? null : { ...pick, profileImageUrl: iconUrl })),
  recent: vi.fn(async () => [smallTalkChat, horrorChat]),
  ...overrides,
})

/** ページを描く。オーバーレイ用キーは既定で発行済みにする */
const renderPage = (api: FocusApi) => render(<FocusPage api={api} />)

/** 操作の結果のお知らせ。役割ではなく文言で探す */
const notice = (text: string): Promise<HTMLElement> => screen.findByText(new RegExp(text))

/**
 * 「いま取り上げているもの」の領域。直近の発言の一覧にも同じ本文・同じ名前のボタンが並ぶため、
 * どちらを見ているかを取り違えないよう領域で絞る
 */
const currentFocusRegion = (): Promise<HTMLElement> => screen.findByRole('group', { name: 'いま取り上げているもの' })

afterEach(cleanup)

describe('いま取り上げているもの', () => {
  test('取り上げていなければ、その旨を出す', async () => {
    renderPage(fakeApi())

    expect(await notice('取り上げていません')).toBeInTheDocument()
  })

  test('取り上げている1件を、アイコン・名前・本文で出す（配信画面に映るものと同じ組み合わせ）', async () => {
    renderPage(fakeApi({ load: vi.fn(async () => focusedChat) }))

    const region = await currentFocusRegion()
    expect(within(region).getByText('今から怖い話をするね')).toBeInTheDocument()
    expect(within(region).getByText(/怖い話す人/)).toBeInTheDocument()
    expect(region.querySelector('img')).toHaveAttribute('src', iconUrl)
  })

  test('取り上げているものを外せる', async () => {
    const api = fakeApi({ load: vi.fn(async () => focusedChat) })
    renderPage(api)
    await currentFocusRegion()

    await userEvent.click(screen.getByRole('button', { name: '取り上げをやめる' }))

    expect(api.save).toHaveBeenCalledWith(null)
    expect(await notice('取り上げていません')).toBeInTheDocument()
  })

  test('読み込みに失敗したら理由を出す', async () => {
    renderPage(fakeApi({ load: vi.fn(async () => Promise.reject(new Error('ログインしてください'))) }))

    expect(await notice('ログインしてください')).toBeInTheDocument()
  })
})

describe('直近の発言から選ぶ', () => {
  test('いま進んでいる配信の直近の発言を、新しい順に出す', async () => {
    renderPage(fakeApi())

    const list = await screen.findByRole('list', { name: '直近の発言' })
    const items = within(list).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('キーボードは結局どれを買ったんですか？')
    expect(items[1]).toHaveTextContent('今から怖い話をするね')
  })

  test('発言が1件もなければ、その旨を出す', async () => {
    renderPage(fakeApi({ recent: vi.fn(async () => []) }))

    expect(await notice('配信中の発言がありません')).toBeInTheDocument()
  })

  test('選んだ1件を取り上げる', async () => {
    const api = fakeApi()
    renderPage(api)
    const list = await screen.findByRole('list', { name: '直近の発言' })

    const horrorRow = within(list).getAllByRole('listitem')[1]!
    await userEvent.click(within(horrorRow).getByRole('button', { name: 'この発言を取り上げる' }))

    expect(api.save).toHaveBeenCalledWith({
      messageId: '発言1',
      login: 'kowai_hanashi',
      displayName: '怖い話す人',
      text: '今から怖い話をするね',
    })
  })

  test('取り上げたら、いま取り上げている1件としてアイコン付きで出す', async () => {
    renderPage(fakeApi())
    const list = await screen.findByRole('list', { name: '直近の発言' })

    await userEvent.click(within(within(list).getAllByRole('listitem')[1]!).getByRole('button', { name: 'この発言を取り上げる' }))

    expect(await notice('怖い話す人 さんの発言を取り上げました')).toBeInTheDocument()
    expect((await currentFocusRegion()).querySelector('img')).toHaveAttribute('src', iconUrl)
  })

  test('取り上げに失敗したら理由を出す（発言した人のアイコンを引けなかったときなど）', async () => {
    renderPage(fakeApi({ save: vi.fn(async () => Promise.reject(new Error('Twitchにログイン名 kowai_hanashi のアイコンがありません'))) }))
    const list = await screen.findByRole('list', { name: '直近の発言' })

    await userEvent.click(within(within(list).getAllByRole('listitem')[1]!).getByRole('button', { name: 'この発言を取り上げる' }))

    expect(await notice('アイコンがありません')).toBeInTheDocument()
  })

  test('一覧を読み直せる', async () => {
    const api = fakeApi()
    renderPage(api)
    await screen.findByRole('list', { name: '直近の発言' })

    await userEvent.click(screen.getByRole('button', { name: '発言を読み直す' }))

    expect(api.recent).toHaveBeenCalledTimes(2)
  })

  test('読み直しはアイコンだけのボタンにし、名前は読み上げとホバー（title）に残す', async () => {
    renderPage(fakeApi())
    await screen.findByRole('list', { name: '直近の発言' })

    const reloadButton = screen.getByRole('button', { name: '発言を読み直す' })
    expect(reloadButton).toHaveTextContent('')
    expect(reloadButton).toHaveAttribute('title', '発言を読み直す')
  })

  test('一覧の読み込みに失敗したら理由を出す', async () => {
    renderPage(fakeApi({ recent: vi.fn(async () => Promise.reject(new Error('配信の記録を読めませんでした'))) }))

    expect(await notice('配信の記録を読めませんでした')).toBeInTheDocument()
  })
})

describe('配信画面への出し方', () => {
  test('OBSに貼るURLは出さず、合成オーバーレイの管理画面へ案内する', async () => {
    renderPage(fakeApi())

    // 注目コメント専用のページは消したので（issue #107）、この画面はURLを配らない
    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'オーバーレイの構成を開く' })).toHaveAttribute('href', '/overlay/')
  })
})
