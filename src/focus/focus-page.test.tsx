// @vitest-environment jsdom
/**
 * 注目コメントのページ（取り上げるものの指定とOBS用URL）のテスト
 *
 * 確かめること:
 * - いま取り上げているものを出すこと（人に追従・発言1件を取り上げ・取り上げていない）
 * - ログイン名を入れて、その人に追従できること
 * - 直近の発言の一覧から、1件を取り上げられること・その人に追従できること
 * - 取り上げているものを外せること
 * - 失敗は黙って無視せず、理由を出すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { FocusApi, PickableMessage } from './api'
import type { FocusTarget } from './focused'
import { FocusPage } from './focus-page'

const オーバーレイ用キー = 'issued-overlay-key-0123456789abcdefghij'

const 怖い話の発言: PickableMessage = {
  messageId: '発言1',
  login: 'kowai_hanashi',
  displayName: '怖い話す人',
  text: '今から怖い話をするね',
  at: '2026-09-27T12:10:00.000Z',
}

const 雑談の発言: PickableMessage = {
  messageId: '発言2',
  login: 'zatsudan_suki',
  displayName: '雑談好き',
  text: 'キーボードは結局どれを買ったんですか？',
  at: '2026-09-27T12:11:00.000Z',
}

/** 怖い話を始めた視聴者に追従している状態 */
const 追従の指定: FocusTarget = { type: 'viewer', login: 'kowai_hanashi' }

/** 発言1件を取り上げている状態 */
const 取り上げの指定: FocusTarget = {
  type: 'message',
  messageId: '発言1',
  login: 'kowai_hanashi',
  displayName: '怖い話す人',
  text: '今から怖い話をするね',
}

const 代役のAPI = (overrides: Partial<FocusApi> = {}): FocusApi => ({
  load: vi.fn(async () => null),
  save: vi.fn(async (target: FocusTarget | null) => target),
  recent: vi.fn(async () => [雑談の発言, 怖い話の発言]),
  ...overrides,
})

/** ページを描く。オーバーレイ用キーは既定で発行済みにする */
const 描く = (api: FocusApi, overlayKey: string | null = オーバーレイ用キー) => render(<FocusPage api={api} overlayKey={overlayKey} />)

/** 操作の結果のお知らせ。役割ではなく文言で探す */
const お知らせ = (text: string): Promise<HTMLElement> => screen.findByText(new RegExp(text))

/**
 * 「いま取り上げているもの」の領域。直近の発言の一覧にも同じ本文・同じ名前のボタンが並ぶため、
 * どちらを見ているかを取り違えないよう領域で絞る
 */
const いま取り上げている領域 = (): Promise<HTMLElement> => screen.findByRole('group', { name: 'いま取り上げているもの' })

/** ログイン名を入れて追従する領域 */
const 追従の領域 = (): HTMLElement => screen.getByRole('group', { name: '人に追従する' })

afterEach(cleanup)

describe('いま取り上げているもの', () => {
  test('取り上げていなければ、その旨を出す', async () => {
    描く(代役のAPI())

    expect(await お知らせ('取り上げていません')).toBeInTheDocument()
  })

  test('人に追従しているときは、その人のログイン名を出す', async () => {
    描く(代役のAPI({ load: vi.fn(async () => 追従の指定) }))

    expect(within(await いま取り上げている領域()).getByText(/kowai_hanashi/)).toBeInTheDocument()
  })

  test('発言1件を取り上げているときは、その本文と発言者を出す', async () => {
    描く(代役のAPI({ load: vi.fn(async () => 取り上げの指定) }))

    const 領域 = within(await いま取り上げている領域())
    expect(領域.getByText('今から怖い話をするね')).toBeInTheDocument()
    expect(領域.getByText(/怖い話す人/)).toBeInTheDocument()
  })

  test('取り上げているものを外せる', async () => {
    const api = 代役のAPI({ load: vi.fn(async () => 追従の指定) })
    描く(api)
    await いま取り上げている領域()

    await userEvent.click(screen.getByRole('button', { name: '取り上げをやめる' }))

    expect(api.save).toHaveBeenCalledWith(null)
    expect(await お知らせ('取り上げていません')).toBeInTheDocument()
  })

  test('読み込みに失敗したら理由を出す', async () => {
    描く(代役のAPI({ load: vi.fn(async () => Promise.reject(new Error('ログインしてください'))) }))

    expect(await お知らせ('ログインしてください')).toBeInTheDocument()
  })
})

describe('人に追従する', () => {
  test('ログイン名を入れて追従できる', async () => {
    const api = 代役のAPI()
    描く(api)
    await お知らせ('取り上げていません')

    await userEvent.type(screen.getByLabelText('追従する人のログイン名'), 'kowai_hanashi')
    await userEvent.click(within(追従の領域()).getByRole('button', { name: 'この人に追従する' }))

    expect(api.save).toHaveBeenCalledWith({ type: 'viewer', login: 'kowai_hanashi' })
  })

  test('保存に失敗したら理由を出す', async () => {
    const api = 代役のAPI({ save: vi.fn(async () => Promise.reject(new Error('ログイン名が正しくありません'))) })
    描く(api)
    await お知らせ('取り上げていません')

    await userEvent.type(screen.getByLabelText('追従する人のログイン名'), '怖い話す人')
    await userEvent.click(within(追従の領域()).getByRole('button', { name: 'この人に追従する' }))

    expect(await お知らせ('ログイン名が正しくありません')).toBeInTheDocument()
  })
})

describe('直近の発言から選ぶ', () => {
  test('いま進んでいる配信の直近の発言を、新しい順に出す', async () => {
    描く(代役のAPI())

    const list = await screen.findByRole('list', { name: '直近の発言' })
    const items = within(list).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('キーボードは結局どれを買ったんですか？')
    expect(items[1]).toHaveTextContent('今から怖い話をするね')
  })

  test('発言が1件もなければ、その旨を出す', async () => {
    描く(代役のAPI({ recent: vi.fn(async () => []) }))

    expect(await お知らせ('配信中の発言がありません')).toBeInTheDocument()
  })

  test('選んだ1件を取り上げる', async () => {
    const api = 代役のAPI()
    描く(api)
    const list = await screen.findByRole('list', { name: '直近の発言' })

    const 怖い話の行 = within(list).getAllByRole('listitem')[1]!
    await userEvent.click(within(怖い話の行).getByRole('button', { name: 'この発言を取り上げる' }))

    expect(api.save).toHaveBeenCalledWith({
      type: 'message',
      messageId: '発言1',
      login: 'kowai_hanashi',
      displayName: '怖い話す人',
      text: '今から怖い話をするね',
    })
  })

  test('一覧の行でできるのは発言を取り上げることだけで、人への追従は混ぜない（2つのモードは別のものなので、選ぶ場所も分ける）', async () => {
    描く(代役のAPI())
    const list = await screen.findByRole('list', { name: '直近の発言' })

    const 怖い話の行 = within(list).getAllByRole('listitem')[1]!
    expect(within(怖い話の行).getAllByRole('button')).toHaveLength(1)
    expect(within(怖い話の行).queryByRole('button', { name: 'この人に追従する' })).not.toBeInTheDocument()
  })

  test('一覧を読み直せる', async () => {
    const api = 代役のAPI()
    描く(api)
    await screen.findByRole('list', { name: '直近の発言' })

    await userEvent.click(screen.getByRole('button', { name: '発言を読み直す' }))

    expect(api.recent).toHaveBeenCalledTimes(2)
  })

  test('一覧の読み込みに失敗したら理由を出す', async () => {
    描く(代役のAPI({ recent: vi.fn(async () => Promise.reject(new Error('配信の記録を読めませんでした'))) }))

    expect(await お知らせ('配信の記録を読めませんでした')).toBeInTheDocument()
  })
})

describe('OBS用のURL', () => {
  test('オーバーレイ用キーが発行されていなければ、その旨を出す', () => {
    描く(代役のAPI(), null)

    expect(screen.getByText(/オーバーレイ用キーが発行されていません/)).toBeInTheDocument()
  })

  test('オーバーレイのURLを出す', async () => {
    描く(代役のAPI())

    const field = await screen.findByLabelText('OBSのブラウザソースに貼るURL')
    expect(field).toHaveValue(`${window.location.origin}/focus/overlay/?key=${オーバーレイ用キー}`)
  })
})
