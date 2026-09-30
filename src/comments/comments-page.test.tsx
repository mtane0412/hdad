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
 * - 配信者としてチャットを送れること（IMEの変換確定の Enter では送らない）
 * - その配信で初めての発言に「挨拶した」を付け外しでき、印は配送先から届いた付け替えで付くこと
 * - まだ挨拶していない初めての発言を目立たせ、上部の一覧からその行へ移れること
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { FocusApi, FocusPick } from '@/focus/api'
import type { CommentApi } from './api'
import { CommentsPage } from './comments-page'
import type { FeedItem } from './feed'
import type { CommentFeedHandlers } from './socket'

afterEach(cleanup)

const regularViewer = { id: '777', login: 'jouren_san', name: '常連さん' }

const regularViewerChat: FeedItem = {
  kind: 'chat',
  id: '通知1',
  at: Date.parse('2026-09-29T12:00:00Z'),
  messageId: '発言1',
  user: regularViewer,
  color: '#FF4500',
  badges: [{ setId: 'subscriber', versionId: '12' }],
  fragments: [
    { text: 'こんばんは ', emoteId: null },
    { text: 'Kappa', emoteId: '25' },
  ],
  bits: null,
  reply: null,
  firstOfStream: false,
}

const createFakeApi = (overrides: Partial<CommentApi> = {}): CommentApi => ({
  loadIcons: vi.fn(async () => ({ '777': 'https://static-cdn.jtvnw.net/jtv_user_pictures/jouren.png' })),
  loadBadges: vi.fn(async () => new Map([['subscriber/12', { url: 'https://static-cdn.jtvnw.net/badges/v1/subscriber-12/1', title: '1-Year Subscriber' }]])),
  // Worker と同じく、タイムアウトなら決めた長さを添えて返す
  moderate: vi.fn(async (action) => (action === 'timeout' ? { action, durationSeconds: 600 } : { action })),
  send: vi.fn(async () => {}),
  markGreeted: vi.fn(async () => {}),
  ...overrides,
})

/** 注目コメントの代役。既定では何も取り上げておらず、選んだ発言にアイコンを添えて返す（Worker と同じ） */
const createFakeFocusApi = (overrides: Partial<FocusApi> = {}): FocusApi => ({
  load: vi.fn(async () => null),
  save: vi.fn(async (pick: FocusPick | null) => (pick === null ? null : { ...pick, profileImageUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/jouren.png' })),
  recent: vi.fn(async () => []),
  ...overrides,
})

/** ページを描き、配送先の代わりに文字列を流し込める窓口を返す */
const renderPage = (api: CommentApi = createFakeApi(), focusApi: FocusApi = createFakeFocusApi()) => {
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
  const getHandlers = (): CommentFeedHandlers => {
    if (!handlers) throw new Error('ページが配送先につないでいません')
    return handlers
  }
  return {
    close,
    receive: (message: unknown) => act(() => getHandlers().onMessage(JSON.stringify(message))),
    receiveUnreadable: (text: string) => act(() => getHandlers().onMessage(text)),
    disconnect: () => act(() => getHandlers().onStatus('disconnected')),
  }
}

/** 並びの1行を、書かれている文字で探す */
const findRow = (text: string | RegExp): HTMLElement => {
  const feedList = screen.getByRole('list', { name: 'チャットと出来事' })
  const found = within(feedList)
    .getAllByRole('listitem')
    .find((item) => (typeof text === 'string' ? item.textContent?.includes(text) : text.test(item.textContent ?? '')))
  if (!found) throw new Error(`「${String(text)}」の行がありません`)
  return found
}

describe('CommentsPage', () => {
  test('届いた発言を、名前・バッジ・本文で並べ、エモートは画像で出す', async () => {
    const { receive } = renderPage()

    await receive({ type: 'backlog', items: [regularViewerChat] })

    const chatRow = findRow('常連さん')
    expect(chatRow).toHaveTextContent('こんばんは')
    expect(within(chatRow).getByRole('img', { name: 'Kappa' })).toHaveAttribute('src', expect.stringContaining('/emoticons/v2/25/'))
    expect(await within(chatRow).findByRole('img', { name: '1-Year Subscriber' })).toBeInTheDocument()
  })

  test('発言した人のアイコンを問い合わせて出す', async () => {
    const api = createFakeApi()
    const { receive } = renderPage(api)

    await receive({ type: 'item', item: regularViewerChat })

    // アイコンは隣の名前と同じ人を指す飾りなので、代替文字は空にしている
    await vi.waitFor(() => expect(findRow('常連さん').querySelector('img[src$="jouren.png"]')).not.toBeNull())
    expect(api.loadIcons).toHaveBeenCalledWith(['777'])
  })

  test('出来事を1行の文で並べる', async () => {
    const { receive } = renderPage()

    await receive({
      type: 'backlog',
      items: [
        { kind: 'follow', id: '通知2', at: 0, user: { id: '888', login: 'shoken_san', name: '初見さん' } },
        { kind: 'redemption', id: '通知3', at: 0, user: regularViewer, reward: '質問する', cost: 500, input: '好きな食べ物は？' },
      ],
    })

    expect(findRow('初見さん さんがフォローしました')).toBeInTheDocument()
    expect(findRow('「質問する」を引き換えました')).toHaveTextContent('好きな食べ物は？')
  })

  test('モデレーターに消された発言には「削除済み」の印を付ける', async () => {
    const { receive } = renderPage()

    await receive({ type: 'item', item: regularViewerChat })
    await receive({ type: 'item', item: { kind: 'delete', id: '通知4', at: 0, messageId: '発言1' } })

    expect(findRow('常連さん')).toHaveTextContent('削除済み')
  })

  test('読み取れないものが届いたら、黙らずに知らせる', async () => {
    const { receiveUnreadable } = renderPage()

    await receiveUnreadable('{"type":"item","item":{"kind":"hug"}}')

    expect(screen.getByRole('alert')).toHaveTextContent('想定した形ではありません')
  })

  test('接続が切れたら知らせる', async () => {
    const { disconnect } = renderPage()

    await disconnect()

    expect(screen.getByText(/接続が切れました/)).toBeInTheDocument()
  })

  test('アイコンを引けなかったら、黙らずに知らせる', async () => {
    const { receive } = renderPage(createFakeApi({ loadIcons: vi.fn(async () => Promise.reject(new Error('Twitchに問い合わせられませんでした'))) }))

    await receive({ type: 'item', item: regularViewerChat })

    expect(await screen.findByRole('alert')).toHaveTextContent('Twitchに問い合わせられませんでした')
  })

  test('アイコンを引けなかった人は、次に1件届いたときに問い合わせ直す（一時的な失敗でアイコンが出ないままにしない）', async () => {
    const loadIcons = vi
      .fn<CommentApi['loadIcons']>()
      .mockRejectedValueOnce(new Error('Twitchに問い合わせられませんでした'))
      .mockResolvedValue({ '777': 'https://static-cdn.jtvnw.net/jtv_user_pictures/jouren.png' })
    const { receive } = renderPage(createFakeApi({ loadIcons }))

    await receive({ type: 'item', item: regularViewerChat })
    await screen.findByRole('alert')
    await receive({ type: 'item', item: { ...regularViewerChat, id: '通知5', messageId: '発言5' } })

    await vi.waitFor(() => expect(loadIcons).toHaveBeenCalledTimes(2))
    expect(loadIcons).toHaveBeenLastCalledWith(['777'])
  })

  test('画面を離れるときは接続を閉じる（行き来するたびに接続が増えないように）', () => {
    const { close } = renderPage()

    cleanup()

    expect(close).toHaveBeenCalled()
  })

  describe('注目コメント', () => {
    /** 発言の行にある、注目コメントに設定するボタン */
    const focusButton = (text: string) => within(findRow(text)).getByRole('button', { name: 'この発言を注目コメントにする' })

    test('発言の行のボタンを押すと、その発言を注目コメントに設定する', async () => {
      const focusApi = createFakeFocusApi()
      const { receive } = renderPage(createFakeApi(), focusApi)
      await receive({ type: 'item', item: regularViewerChat })

      await userEvent.click(focusButton('常連さん'))

      expect(focusApi.save).toHaveBeenCalledWith({ messageId: '発言1', login: 'jouren_san', displayName: '常連さん', text: 'こんばんは Kappa' })
      expect(await screen.findByText('常連さん さんの発言を注目コメントにしました')).toBeInTheDocument()
      // 取り上げている発言には印が付き、ボタンは押された状態になる
      expect(findRow('常連さん')).toHaveTextContent('注目中')
      expect(focusButton('常連さん')).toHaveAttribute('aria-pressed', 'true')
    })

    test('開いたときに、すでに取り上げている発言に印を付ける', async () => {
      const focusApi = createFakeFocusApi({
        load: vi.fn(async () => ({ messageId: '発言1', login: 'jouren_san', displayName: '常連さん', text: 'こんばんは Kappa', profileImageUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/jouren.png' })),
      })
      const { receive } = renderPage(createFakeApi(), focusApi)

      await receive({ type: 'item', item: regularViewerChat })

      await vi.waitFor(() => expect(findRow('常連さん')).toHaveTextContent('注目中'))
    })

    test('取り上げている発言のボタンをもう一度押すと、取り上げをやめる', async () => {
      const focusApi = createFakeFocusApi()
      const { receive } = renderPage(createFakeApi(), focusApi)
      await receive({ type: 'item', item: regularViewerChat })
      await userEvent.click(focusButton('常連さん'))
      await screen.findByText('常連さん さんの発言を注目コメントにしました')

      await userEvent.click(focusButton('常連さん'))

      expect(focusApi.save).toHaveBeenLastCalledWith(null)
      expect(await screen.findByText('注目コメントの取り上げをやめました')).toBeInTheDocument()
      expect(findRow('常連さん')).not.toHaveTextContent('注目中')
    })

    test('ほかの画面で別の発言に取り上げ直されていたら、やめずに表示を合わせる（ほかの画面の選択を消さないため）', async () => {
      const otherChat = { messageId: '発言9', login: 'shoken_san', displayName: '初見さん', text: 'はじめまして', profileImageUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/shoken.png' }
      const focusApi = createFakeFocusApi()
      const { receive } = renderPage(createFakeApi(), focusApi)
      await receive({ type: 'item', item: regularViewerChat })
      await userEvent.click(focusButton('常連さん'))
      await screen.findByText('常連さん さんの発言を注目コメントにしました')
      // 前提: このあと注目コメントのページで、別の発言に取り上げ直された
      vi.mocked(focusApi.load).mockResolvedValue(otherChat)

      await userEvent.click(focusButton('常連さん'))

      expect(focusApi.save).not.toHaveBeenLastCalledWith(null)
      expect(await screen.findByText(/ほかの画面で別の発言に変わっていた/)).toBeInTheDocument()
      expect(findRow('常連さん')).not.toHaveTextContent('注目中')
    })

    test('開いたときの読み込みが保存より遅れて返っても、保存した印を上書きしない', async () => {
      // 前提: 開いたときの読み込み（取り上げていない）が、発言を取り上げたあとに返ってくる
      let resolveLoad: (target: null) => void = () => {}
      const focusApi = createFakeFocusApi({ load: vi.fn(() => new Promise<null>((resolve) => (resolveLoad = resolve))) })
      const { receive } = renderPage(createFakeApi(), focusApi)
      await receive({ type: 'item', item: regularViewerChat })
      await userEvent.click(focusButton('常連さん'))
      await screen.findByText('常連さん さんの発言を注目コメントにしました')

      await act(async () => resolveLoad(null))

      expect(findRow('常連さん')).toHaveTextContent('注目中')
    })

    test('モデレーターに消された発言は取り上げられない（配信画面に出さないため）', async () => {
      const { receive } = renderPage()
      await receive({ type: 'item', item: regularViewerChat })
      await receive({ type: 'item', item: { kind: 'delete', id: '通知4', at: 0, messageId: '発言1' } })

      expect(focusButton('常連さん')).toBeDisabled()
    })

    test('設定に失敗したら、理由を出す', async () => {
      const focusApi = createFakeFocusApi({ save: vi.fn(async () => Promise.reject(new Error('Twitchにログイン名 jouren_san のアイコンがありません'))) })
      const { receive } = renderPage(createFakeApi(), focusApi)
      await receive({ type: 'item', item: regularViewerChat })

      await userEvent.click(focusButton('常連さん'))

      expect(await screen.findByText('Twitchにログイン名 jouren_san のアイコンがありません')).toBeInTheDocument()
      expect(findRow('常連さん')).not.toHaveTextContent('注目中')
    })
  })

  describe('モデレーターの操作', () => {
    /** 発言の行にある、モデレーターの操作のボタン */
    const actionButton = (text: string, name: string) => within(findRow(text)).getByRole('button', { name })

    test('発言を削除する', async () => {
      const api = createFakeApi()
      const { receive } = renderPage(api)
      await receive({ type: 'item', item: regularViewerChat })

      await userEvent.click(actionButton('常連さん', 'この発言を削除'))

      expect(api.moderate).toHaveBeenCalledWith('delete', { messageId: '発言1', userId: '777' })
      expect(await screen.findByText('常連さん さんの発言を削除しました')).toBeInTheDocument()
    })

    test('発言した人をタイムアウトする（長さはWorkerが決めたものを出す）', async () => {
      const api = createFakeApi()
      const { receive } = renderPage(api)
      await receive({ type: 'item', item: regularViewerChat })

      await userEvent.click(actionButton('常連さん', 'この人をタイムアウト'))

      expect(api.moderate).toHaveBeenCalledWith('timeout', { messageId: '発言1', userId: '777' })
      expect(await screen.findByText('常連さん さんを10分タイムアウトしました')).toBeInTheDocument()
    })

    test('BANは確かめてから行う', async () => {
      const api = createFakeApi()
      const { receive } = renderPage(api)
      await receive({ type: 'item', item: regularViewerChat })

      await userEvent.click(actionButton('常連さん', 'この人をBAN'))
      // 確かめる前には、まだBANしていない
      expect(api.moderate).not.toHaveBeenCalled()
      const dialog = await screen.findByRole('alertdialog')
      expect(dialog).toHaveTextContent('常連さん')
      await userEvent.click(within(dialog).getByRole('button', { name: 'BANする' }))

      expect(api.moderate).toHaveBeenCalledWith('ban', { messageId: '発言1', userId: '777' })
      expect(await screen.findByText('常連さん さんをBANしました')).toBeInTheDocument()
    })

    test('BANの確認で「やめる」を選んだら、BANしない', async () => {
      const api = createFakeApi()
      const { receive } = renderPage(api)
      await receive({ type: 'item', item: regularViewerChat })

      await userEvent.click(actionButton('常連さん', 'この人をBAN'))
      await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'やめる' }))

      expect(api.moderate).not.toHaveBeenCalled()
    })

    test('すでに消された発言は削除できないが、その人のタイムアウト・BANはできる', async () => {
      const { receive } = renderPage()
      await receive({ type: 'item', item: regularViewerChat })
      await receive({ type: 'item', item: { kind: 'delete', id: '通知4', at: 0, messageId: '発言1' } })

      expect(actionButton('常連さん', 'この発言を削除')).toBeDisabled()
      expect(actionButton('常連さん', 'この人をタイムアウト')).toBeEnabled()
      expect(actionButton('常連さん', 'この人をBAN')).toBeEnabled()
    })

    test('削除に成功したら、Twitchから消えた知らせが届く前でも、同じ発言をもう一度削除させない', async () => {
      const api = createFakeApi()
      const { receive } = renderPage(api)
      await receive({ type: 'item', item: regularViewerChat })

      await userEvent.click(actionButton('常連さん', 'この発言を削除'))
      await screen.findByText('常連さん さんの発言を削除しました')

      expect(actionButton('常連さん', 'この発言を削除')).toBeDisabled()
      // 印（削除済み）は Twitch の知らせを待って付けるので、まだ付けない
      expect(findRow('常連さん')).not.toHaveTextContent('削除済み')
    })

    test('処分に失敗したら、理由を出す（botがモデレーターでないなど）', async () => {
      const api = createFakeApi({ moderate: vi.fn(async () => Promise.reject(new Error('botがこのチャンネルのモデレーターではありません'))) })
      const { receive } = renderPage(api)
      await receive({ type: 'item', item: regularViewerChat })

      await userEvent.click(actionButton('常連さん', 'この発言を削除'))

      expect(await screen.findByText('botがこのチャンネルのモデレーターではありません')).toBeInTheDocument()
    })
  })

  describe('チャットを送る', () => {
    const chatInput = () => screen.getByRole('textbox', { name: 'チャットに送る文言' })

    test('文言を入れて Enter を押すと、配信者としてチャットへ送り、入力欄を空にする', async () => {
      const api = createFakeApi()
      renderPage(api)

      await userEvent.type(chatInput(), 'みなさん来てくれてありがとう{Enter}')

      expect(api.send).toHaveBeenCalledWith('みなさん来てくれてありがとう')
      await vi.waitFor(() => expect(chatInput()).toHaveValue(''))
    })

    test('送信のボタンでも送れる', async () => {
      const api = createFakeApi()
      renderPage(api)

      await userEvent.type(chatInput(), 'こんばんは')
      await userEvent.click(screen.getByRole('button', { name: '送信' }))

      expect(api.send).toHaveBeenCalledWith('こんばんは')
    })

    test('日本語入力の変換を確定する Enter では送らない', () => {
      const api = createFakeApi()
      renderPage(api)
      fireEvent.change(chatInput(), { target: { value: 'ありがとう' } })

      // 変換中（isComposing）の Enter は、候補を確定するためのもので送信の合図ではない
      fireEvent.keyDown(chatInput(), { key: 'Enter', isComposing: true })

      expect(api.send).not.toHaveBeenCalled()
    })

    test('Safari の変換確定の Enter（isComposing が false でも keyCode が 229）でも送らない', () => {
      const api = createFakeApi()
      renderPage(api)
      fireEvent.change(chatInput(), { target: { value: 'ありがとう' } })

      fireEvent.keyDown(chatInput(), { key: 'Enter', keyCode: 229, isComposing: false })

      expect(api.send).not.toHaveBeenCalled()
    })

    test('送っているあいだに書き足した文言は、送り終えても消さない', async () => {
      // 前提: 送信が終わる前に、配信者が次の文言を打ち始める
      let finishSend: () => void = () => {}
      const api = createFakeApi({ send: vi.fn(() => new Promise<void>((resolve) => (finishSend = resolve))) })
      renderPage(api)
      await userEvent.type(chatInput(), 'こんばんは{Enter}')
      fireEvent.change(chatInput(), { target: { value: '次の話題は' } })

      await act(async () => finishSend())

      expect(api.send).toHaveBeenCalledWith('こんばんは')
      expect(chatInput()).toHaveValue('次の話題は')
    })

    test('画面が描き直される前に Enter が2回届いても、同じ文言を2度送らない', async () => {
      let finishSend: () => void = () => {}
      const api = createFakeApi({ send: vi.fn(() => new Promise<void>((resolve) => (finishSend = resolve))) })
      renderPage(api)
      fireEvent.change(chatInput(), { target: { value: 'こんばんは' } })

      // 前提: 2回の Enter のあいだに描き直しが入らない（素早い連打）
      act(() => {
        chatInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        chatInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      await act(async () => finishSend())

      expect(api.send).toHaveBeenCalledTimes(1)
    })

    test('送れなかったあとは、もう一度送れる', async () => {
      const send = vi.fn<CommentApi['send']>().mockRejectedValueOnce(new Error('Twitchがチャットを送信しませんでした')).mockResolvedValue()
      renderPage(createFakeApi({ send }))

      await userEvent.type(chatInput(), 'こんばんは{Enter}')
      await screen.findByText(/Twitchがチャットを送信しませんでした/)
      await userEvent.type(chatInput(), '{Enter}')

      expect(send).toHaveBeenCalledTimes(2)
    })

    test('送れなかったら理由を出し、入れた文言は消さない（許可を取り直していないなど）', async () => {
      const api = createFakeApi({ send: vi.fn(async () => Promise.reject(new Error('配信者のトークンに user:write:chat がありません。ログインし直してください'))) })
      renderPage(api)

      await userEvent.type(chatInput(), 'こんばんは{Enter}')

      expect(await screen.findByText(/ログインし直してください/)).toBeInTheDocument()
      expect(chatInput()).toHaveValue('こんばんは')
    })
  })

  describe('初めての発言への挨拶', () => {
    const firstTimeViewer = { id: '888', login: 'shoken_san', name: '初見さん' }

    /** 初見さんの、その配信で初めての発言 */
    const firstChat: FeedItem = {
      kind: 'chat',
      id: '通知2',
      at: Date.parse('2026-09-29T12:00:30Z'),
      messageId: '初見さんの初めての発言',
      user: firstTimeViewer,
      color: null,
      badges: [],
      fragments: [{ text: 'はじめまして', emoteId: null }],
      bits: null,
      reply: null,
      firstOfStream: true,
    }

    /** 発言の行にある、挨拶のボタン */
    const greetButton = (text: string) => within(findRow(text)).getByRole('button', { name: 'この人に挨拶した' })

    /** 配送先から届く、挨拶の付け替え */
    const greetingSwitch = (id: string, greeted: boolean): FeedItem => ({
      kind: 'greeting',
      id,
      at: Date.parse('2026-09-29T12:01:00Z'),
      messageId: '初見さんの初めての発言',
      greeted,
    })

    /** 上部の、まだ挨拶していない人の一覧 */
    const pendingList = () => screen.getByRole('region', { name: 'まだ挨拶していない人' })

    test('挨拶のボタンを押すと、Workerに挨拶したと記録するよう頼む（印は付け替えが届くまで付けない）', async () => {
      const api = createFakeApi()
      const { receive } = renderPage(api)
      await receive({ type: 'item', item: firstChat })

      await userEvent.click(greetButton('はじめまして'))

      expect(api.markGreeted).toHaveBeenCalledWith('初見さんの初めての発言', true)
      expect(greetButton('はじめまして')).toHaveAttribute('aria-pressed', 'false')
    })

    test('挨拶の付け替えが届くと、ボタンが押された状態になり、もう一度押すと戻すよう頼む', async () => {
      const api = createFakeApi()
      const { receive } = renderPage(api)
      await receive({ type: 'backlog', items: [firstChat, greetingSwitch('付け替え1', true)] })

      expect(greetButton('はじめまして')).toHaveAttribute('aria-pressed', 'true')
      await userEvent.click(greetButton('はじめまして'))

      expect(api.markGreeted).toHaveBeenCalledWith('初見さんの初めての発言', false)
    })

    test('2回目以降の発言には、挨拶のボタンを出さない', async () => {
      const { receive } = renderPage()

      await receive({ type: 'item', item: regularViewerChat })

      expect(within(findRow('常連さん')).queryByRole('button', { name: 'この人に挨拶した' })).not.toBeInTheDocument()
    })

    test('まだ挨拶していない初めての発言は「未挨拶」として目立たせ、挨拶したら「初コメ」の印だけにする', async () => {
      const { receive } = renderPage()

      await receive({ type: 'item', item: firstChat })
      expect(within(findRow('はじめまして')).getByText('未挨拶')).toBeInTheDocument()

      await receive({ type: 'item', item: greetingSwitch('付け替え1', true) })
      expect(within(findRow('はじめまして')).queryByText('未挨拶')).not.toBeInTheDocument()
      expect(within(findRow('はじめまして')).getByText('初コメ')).toBeInTheDocument()
    })

    test('上部に、まだ挨拶していない人を並べ、挨拶したら一覧から外す', async () => {
      const { receive } = renderPage()

      await receive({ type: 'backlog', items: [regularViewerChat, firstChat] })
      expect(within(pendingList()).getByRole('button', { name: '初見さん' })).toBeInTheDocument()
      expect(within(pendingList()).queryByRole('button', { name: '常連さん' })).not.toBeInTheDocument()

      await receive({ type: 'item', item: greetingSwitch('付け替え1', true) })
      expect(within(pendingList()).queryByRole('button', { name: '初見さん' })).not.toBeInTheDocument()
      expect(within(pendingList()).getByText('まだ挨拶していない初コメはありません')).toBeInTheDocument()
    })

    test('一覧の名前を押すと、その発言の行へ移る', async () => {
      const scrollIntoView = vi.fn()
      Element.prototype.scrollIntoView = scrollIntoView
      const { receive } = renderPage()
      await receive({ type: 'backlog', items: [firstChat, regularViewerChat] })

      await userEvent.click(within(pendingList()).getByRole('button', { name: '初見さん' }))

      expect(scrollIntoView).toHaveBeenCalledTimes(1)
      expect(scrollIntoView.mock.contexts[0]).toBe(findRow('はじめまして'))
    })

    test('挨拶の記録に失敗したら、理由を出す', async () => {
      const api = createFakeApi({
        markGreeted: vi.fn(async () => {
          throw new Error('その配信で初めての発言として記録されていない発言です')
        }),
      })
      const { receive } = renderPage(api)
      await receive({ type: 'item', item: firstChat })

      await userEvent.click(greetButton('はじめまして'))

      expect(await screen.findByText('その配信で初めての発言として記録されていない発言です')).toBeInTheDocument()
    })
  })
})
