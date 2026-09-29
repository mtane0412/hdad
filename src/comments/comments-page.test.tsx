// @vitest-environment jsdom
/**
 * コメントビューアーのページのテスト
 *
 * 配送先への接続は代役に差し替え、テストから文字列を流し込む。確かめること:
 * - 届いた発言を、名前・バッジ・本文（エモートは画像）で並べること
 * - 出来事（サブスク・引き換え・フォローなど）を1行の文で並べること
 * - モデレーターに消された発言に「削除済み」の印を付けること
 * - 発言した人のアイコンを問い合わせて出すこと
 * - 読み取れないものが届いた・接続が切れたときは、黙らずに画面で知らせること
 * - 発言を注目コメントに設定でき、取り上げている発言に印を付け、やめられること
 * - 発言の削除・タイムアウト・BANを行えること（BANは確かめてから）
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { FocusApi, FocusPick } from '@/focus/api'
import type { CommentApi } from './api'
import { CommentsPage } from './comments-page'
import type { FeedItem } from './feed'
import type { CommentFeedHandlers } from './socket'

afterEach(cleanup)

const 常連さん = { id: '777', login: 'jouren_san', name: '常連さん' }

const 常連さんの発言: FeedItem = {
  kind: 'chat',
  id: '通知1',
  at: Date.parse('2026-09-29T12:00:00Z'),
  messageId: '発言1',
  user: 常連さん,
  color: '#FF4500',
  badges: [{ setId: 'subscriber', versionId: '12' }],
  fragments: [
    { text: 'こんばんは ', emoteId: null },
    { text: 'Kappa', emoteId: '25' },
  ],
  bits: null,
  reply: null,
}

const 代役のAPI = (overrides: Partial<CommentApi> = {}): CommentApi => ({
  loadIcons: vi.fn(async () => ({ '777': 'https://static-cdn.jtvnw.net/jtv_user_pictures/jouren.png' })),
  loadBadges: vi.fn(async () => new Map([['subscriber/12', { url: 'https://static-cdn.jtvnw.net/badges/v1/subscriber-12/1', title: '1-Year Subscriber' }]])),
  // Worker と同じく、タイムアウトなら決めた長さを添えて返す
  moderate: vi.fn(async (action) => (action === 'timeout' ? { action, durationSeconds: 600 } : { action })),
  ...overrides,
})

/** 注目コメントの代役。既定では何も取り上げておらず、選んだ発言にアイコンを添えて返す（Worker と同じ） */
const 代役の注目コメントAPI = (overrides: Partial<FocusApi> = {}): FocusApi => ({
  load: vi.fn(async () => null),
  save: vi.fn(async (pick: FocusPick | null) => (pick === null ? null : { ...pick, profileImageUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/jouren.png' })),
  recent: vi.fn(async () => []),
  ...overrides,
})

/** ページを描き、配送先の代わりに文字列を流し込める窓口を返す */
const 描く = (api: CommentApi = 代役のAPI(), focusApi: FocusApi = 代役の注目コメントAPI()) => {
  let handlers: CommentFeedHandlers | undefined
  const close = vi.fn()
  render(
    <CommentsPage
      api={api}
      focusApi={focusApi}
      connect={(next) => {
        handlers = next
        return { close }
      }}
    />,
  )
  const 窓口 = (): CommentFeedHandlers => {
    if (!handlers) throw new Error('ページが配送先につないでいません')
    return handlers
  }
  return {
    close,
    届く: (message: unknown) => act(() => 窓口().onMessage(JSON.stringify(message))),
    読めないものが届く: (text: string) => act(() => 窓口().onMessage(text)),
    切れる: () => act(() => 窓口().onStatus('disconnected')),
  }
}

/** 並びの1行を、書かれている文字で探す */
const 行 = (text: string | RegExp): HTMLElement => {
  const 並び = screen.getByRole('list', { name: 'チャットと出来事' })
  const found = within(並び)
    .getAllByRole('listitem')
    .find((item) => (typeof text === 'string' ? item.textContent?.includes(text) : text.test(item.textContent ?? '')))
  if (!found) throw new Error(`「${String(text)}」の行がありません`)
  return found
}

describe('CommentsPage', () => {
  test('届いた発言を、名前・バッジ・本文で並べ、エモートは画像で出す', async () => {
    const { 届く } = 描く()

    await 届く({ type: 'backlog', items: [常連さんの発言] })

    const 発言の行 = 行('常連さん')
    expect(発言の行).toHaveTextContent('こんばんは')
    expect(within(発言の行).getByRole('img', { name: 'Kappa' })).toHaveAttribute('src', expect.stringContaining('/emoticons/v2/25/'))
    expect(await within(発言の行).findByRole('img', { name: '1-Year Subscriber' })).toBeInTheDocument()
  })

  test('発言した人のアイコンを問い合わせて出す', async () => {
    const api = 代役のAPI()
    const { 届く } = 描く(api)

    await 届く({ type: 'item', item: 常連さんの発言 })

    // アイコンは隣の名前と同じ人を指す飾りなので、代替文字は空にしている
    await vi.waitFor(() => expect(行('常連さん').querySelector('img[src$="jouren.png"]')).not.toBeNull())
    expect(api.loadIcons).toHaveBeenCalledWith(['777'])
  })

  test('出来事を1行の文で並べる', async () => {
    const { 届く } = 描く()

    await 届く({
      type: 'backlog',
      items: [
        { kind: 'follow', id: '通知2', at: 0, user: { id: '888', login: 'shoken_san', name: '初見さん' } },
        { kind: 'redemption', id: '通知3', at: 0, user: 常連さん, reward: '質問する', cost: 500, input: '好きな食べ物は？' },
      ],
    })

    expect(行('初見さん さんがフォローしました')).toBeInTheDocument()
    expect(行('「質問する」を引き換えました')).toHaveTextContent('好きな食べ物は？')
  })

  test('モデレーターに消された発言には「削除済み」の印を付ける', async () => {
    const { 届く } = 描く()

    await 届く({ type: 'item', item: 常連さんの発言 })
    await 届く({ type: 'item', item: { kind: 'delete', id: '通知4', at: 0, messageId: '発言1' } })

    expect(行('常連さん')).toHaveTextContent('削除済み')
  })

  test('読み取れないものが届いたら、黙らずに知らせる', async () => {
    const { 読めないものが届く } = 描く()

    await 読めないものが届く('{"type":"item","item":{"kind":"hug"}}')

    expect(screen.getByRole('alert')).toHaveTextContent('想定した形ではありません')
  })

  test('接続が切れたら知らせる', async () => {
    const { 切れる } = 描く()

    await 切れる()

    expect(screen.getByText(/接続が切れました/)).toBeInTheDocument()
  })

  test('アイコンを引けなかったら、黙らずに知らせる', async () => {
    const { 届く } = 描く(代役のAPI({ loadIcons: vi.fn(async () => Promise.reject(new Error('Twitchに問い合わせられませんでした'))) }))

    await 届く({ type: 'item', item: 常連さんの発言 })

    expect(await screen.findByRole('alert')).toHaveTextContent('Twitchに問い合わせられませんでした')
  })

  test('アイコンを引けなかった人は、次に1件届いたときに問い合わせ直す（一時的な失敗でアイコンが出ないままにしない）', async () => {
    const loadIcons = vi
      .fn<CommentApi['loadIcons']>()
      .mockRejectedValueOnce(new Error('Twitchに問い合わせられませんでした'))
      .mockResolvedValue({ '777': 'https://static-cdn.jtvnw.net/jtv_user_pictures/jouren.png' })
    const { 届く } = 描く(代役のAPI({ loadIcons }))

    await 届く({ type: 'item', item: 常連さんの発言 })
    await screen.findByRole('alert')
    await 届く({ type: 'item', item: { ...常連さんの発言, id: '通知5', messageId: '発言5' } })

    await vi.waitFor(() => expect(loadIcons).toHaveBeenCalledTimes(2))
    expect(loadIcons).toHaveBeenLastCalledWith(['777'])
  })

  test('画面を離れるときは接続を閉じる（行き来するたびに接続が増えないように）', () => {
    const { close } = 描く()

    cleanup()

    expect(close).toHaveBeenCalled()
  })

  describe('注目コメント', () => {
    /** 発言の行にある、注目コメントに設定するボタン */
    const 取り上げるボタン = (text: string) => within(行(text)).getByRole('button', { name: 'この発言を注目コメントにする' })

    test('発言の行のボタンを押すと、その発言を注目コメントに設定する', async () => {
      const focusApi = 代役の注目コメントAPI()
      const { 届く } = 描く(代役のAPI(), focusApi)
      await 届く({ type: 'item', item: 常連さんの発言 })

      await userEvent.click(取り上げるボタン('常連さん'))

      expect(focusApi.save).toHaveBeenCalledWith({ messageId: '発言1', login: 'jouren_san', displayName: '常連さん', text: 'こんばんは Kappa' })
      expect(await screen.findByText('常連さん さんの発言を注目コメントにしました')).toBeInTheDocument()
      // 取り上げている発言には印が付き、ボタンは押された状態になる
      expect(行('常連さん')).toHaveTextContent('注目中')
      expect(取り上げるボタン('常連さん')).toHaveAttribute('aria-pressed', 'true')
    })

    test('開いたときに、すでに取り上げている発言に印を付ける', async () => {
      const focusApi = 代役の注目コメントAPI({
        load: vi.fn(async () => ({ messageId: '発言1', login: 'jouren_san', displayName: '常連さん', text: 'こんばんは Kappa', profileImageUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/jouren.png' })),
      })
      const { 届く } = 描く(代役のAPI(), focusApi)

      await 届く({ type: 'item', item: 常連さんの発言 })

      await vi.waitFor(() => expect(行('常連さん')).toHaveTextContent('注目中'))
    })

    test('取り上げている発言のボタンをもう一度押すと、取り上げをやめる', async () => {
      const focusApi = 代役の注目コメントAPI()
      const { 届く } = 描く(代役のAPI(), focusApi)
      await 届く({ type: 'item', item: 常連さんの発言 })
      await userEvent.click(取り上げるボタン('常連さん'))
      await screen.findByText('常連さん さんの発言を注目コメントにしました')

      await userEvent.click(取り上げるボタン('常連さん'))

      expect(focusApi.save).toHaveBeenLastCalledWith(null)
      expect(await screen.findByText('注目コメントの取り上げをやめました')).toBeInTheDocument()
      expect(行('常連さん')).not.toHaveTextContent('注目中')
    })

    test('ほかの画面で別の発言に取り上げ直されていたら、やめずに表示を合わせる（ほかの画面の選択を消さないため）', async () => {
      const 別の発言 = { messageId: '発言9', login: 'shoken_san', displayName: '初見さん', text: 'はじめまして', profileImageUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/shoken.png' }
      const focusApi = 代役の注目コメントAPI()
      const { 届く } = 描く(代役のAPI(), focusApi)
      await 届く({ type: 'item', item: 常連さんの発言 })
      await userEvent.click(取り上げるボタン('常連さん'))
      await screen.findByText('常連さん さんの発言を注目コメントにしました')
      // 前提: このあと注目コメントのページで、別の発言に取り上げ直された
      vi.mocked(focusApi.load).mockResolvedValue(別の発言)

      await userEvent.click(取り上げるボタン('常連さん'))

      expect(focusApi.save).not.toHaveBeenLastCalledWith(null)
      expect(await screen.findByText(/ほかの画面で別の発言に変わっていた/)).toBeInTheDocument()
      expect(行('常連さん')).not.toHaveTextContent('注目中')
    })

    test('開いたときの読み込みが保存より遅れて返っても、保存した印を上書きしない', async () => {
      // 前提: 開いたときの読み込み（取り上げていない）が、発言を取り上げたあとに返ってくる
      let 読み込みを返す: (target: null) => void = () => {}
      const focusApi = 代役の注目コメントAPI({ load: vi.fn(() => new Promise<null>((resolve) => (読み込みを返す = resolve))) })
      const { 届く } = 描く(代役のAPI(), focusApi)
      await 届く({ type: 'item', item: 常連さんの発言 })
      await userEvent.click(取り上げるボタン('常連さん'))
      await screen.findByText('常連さん さんの発言を注目コメントにしました')

      await act(async () => 読み込みを返す(null))

      expect(行('常連さん')).toHaveTextContent('注目中')
    })

    test('モデレーターに消された発言は取り上げられない（配信画面に出さないため）', async () => {
      const { 届く } = 描く()
      await 届く({ type: 'item', item: 常連さんの発言 })
      await 届く({ type: 'item', item: { kind: 'delete', id: '通知4', at: 0, messageId: '発言1' } })

      expect(取り上げるボタン('常連さん')).toBeDisabled()
    })

    test('設定に失敗したら、理由を出す', async () => {
      const focusApi = 代役の注目コメントAPI({ save: vi.fn(async () => Promise.reject(new Error('Twitchにログイン名 jouren_san のアイコンがありません'))) })
      const { 届く } = 描く(代役のAPI(), focusApi)
      await 届く({ type: 'item', item: 常連さんの発言 })

      await userEvent.click(取り上げるボタン('常連さん'))

      expect(await screen.findByText('Twitchにログイン名 jouren_san のアイコンがありません')).toBeInTheDocument()
      expect(行('常連さん')).not.toHaveTextContent('注目中')
    })
  })

  describe('モデレーターの操作', () => {
    /** 発言の行にある、モデレーターの操作のボタン */
    const 操作のボタン = (text: string, name: string) => within(行(text)).getByRole('button', { name })

    test('発言を削除する', async () => {
      const api = 代役のAPI()
      const { 届く } = 描く(api)
      await 届く({ type: 'item', item: 常連さんの発言 })

      await userEvent.click(操作のボタン('常連さん', 'この発言を削除'))

      expect(api.moderate).toHaveBeenCalledWith('delete', { messageId: '発言1', userId: '777' })
      expect(await screen.findByText('常連さん さんの発言を削除しました')).toBeInTheDocument()
    })

    test('発言した人をタイムアウトする（長さはWorkerが決めたものを出す）', async () => {
      const api = 代役のAPI()
      const { 届く } = 描く(api)
      await 届く({ type: 'item', item: 常連さんの発言 })

      await userEvent.click(操作のボタン('常連さん', 'この人をタイムアウト'))

      expect(api.moderate).toHaveBeenCalledWith('timeout', { messageId: '発言1', userId: '777' })
      expect(await screen.findByText('常連さん さんを10分タイムアウトしました')).toBeInTheDocument()
    })

    test('BANは確かめてから行う', async () => {
      const api = 代役のAPI()
      const { 届く } = 描く(api)
      await 届く({ type: 'item', item: 常連さんの発言 })

      await userEvent.click(操作のボタン('常連さん', 'この人をBAN'))
      // 確かめる前には、まだBANしていない
      expect(api.moderate).not.toHaveBeenCalled()
      const dialog = await screen.findByRole('alertdialog')
      expect(dialog).toHaveTextContent('常連さん')
      await userEvent.click(within(dialog).getByRole('button', { name: 'BANする' }))

      expect(api.moderate).toHaveBeenCalledWith('ban', { messageId: '発言1', userId: '777' })
      expect(await screen.findByText('常連さん さんをBANしました')).toBeInTheDocument()
    })

    test('BANの確認で「やめる」を選んだら、BANしない', async () => {
      const api = 代役のAPI()
      const { 届く } = 描く(api)
      await 届く({ type: 'item', item: 常連さんの発言 })

      await userEvent.click(操作のボタン('常連さん', 'この人をBAN'))
      await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'やめる' }))

      expect(api.moderate).not.toHaveBeenCalled()
    })

    test('すでに消された発言は削除できないが、その人のタイムアウト・BANはできる', async () => {
      const { 届く } = 描く()
      await 届く({ type: 'item', item: 常連さんの発言 })
      await 届く({ type: 'item', item: { kind: 'delete', id: '通知4', at: 0, messageId: '発言1' } })

      expect(操作のボタン('常連さん', 'この発言を削除')).toBeDisabled()
      expect(操作のボタン('常連さん', 'この人をタイムアウト')).toBeEnabled()
      expect(操作のボタン('常連さん', 'この人をBAN')).toBeEnabled()
    })

    test('削除に成功したら、Twitchから消えた知らせが届く前でも、同じ発言をもう一度削除させない', async () => {
      const api = 代役のAPI()
      const { 届く } = 描く(api)
      await 届く({ type: 'item', item: 常連さんの発言 })

      await userEvent.click(操作のボタン('常連さん', 'この発言を削除'))
      await screen.findByText('常連さん さんの発言を削除しました')

      expect(操作のボタン('常連さん', 'この発言を削除')).toBeDisabled()
      // 印（削除済み）は Twitch の知らせを待って付けるので、まだ付けない
      expect(行('常連さん')).not.toHaveTextContent('削除済み')
    })

    test('処分に失敗したら、理由を出す（botがモデレーターでないなど）', async () => {
      const api = 代役のAPI({ moderate: vi.fn(async () => Promise.reject(new Error('botがこのチャンネルのモデレーターではありません'))) })
      const { 届く } = 描く(api)
      await 届く({ type: 'item', item: 常連さんの発言 })

      await userEvent.click(操作のボタン('常連さん', 'この発言を削除'))

      expect(await screen.findByText('botがこのチャンネルのモデレーターではありません')).toBeInTheDocument()
    })
  })
})

