// @vitest-environment jsdom
/**
 * チャットボットのページのテスト
 *
 * 確かめること:
 * - 未接続なら接続の案内を出し、接続済みならどのアカウントかが分かること
 * - スコープが足りない接続は、そのまま使えるように見せず、接続し直しを促すこと
 * - 切断は確認してから行うこと（配信中に誤って押しても止まらないように）
 * - テスト送信で本文をWorkerへ送り、失敗したら理由を出すこと（黙って成功したように見せない）
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { BotPage } from './bot-page'
import type { BotApi, BotStatus } from './api'

const 接続済みのbot: BotStatus = { userId: '67890', login: 'haishinsha_bot', missingScopes: [] }

/** botが接続済みのWorkerの代役 */
const 代役のAPI = (overrides: Partial<BotApi> = {}): BotApi => ({
  status: vi.fn(async () => 接続済みのbot),
  disconnect: vi.fn(async () => {}),
  sendMessage: vi.fn(async () => {}),
  ...overrides,
})

const お知らせ = (text: string): Promise<HTMLElement> => screen.findByText(new RegExp(text))

afterEach(cleanup)

describe('接続状態', () => {
  test('接続済みなら、botのログイン名を出す', async () => {
    render(<BotPage api={代役のAPI()} />)

    expect(await お知らせ('haishinsha_bot')).toBeInTheDocument()
  })

  test('未接続なら、接続のリンクを出す（Twitchの認可画面へ送るので普通のリンクにする）', async () => {
    render(<BotPage api={代役のAPI({ status: vi.fn(async () => null) })} />)

    const link = await screen.findByRole('link', { name: /接続/ })
    expect(link).toHaveAttribute('href', '/api/auth/login?role=bot')
  })

  test('スコープが足りなければ、不足しているスコープと接続し直しの案内を出す', async () => {
    const api = 代役のAPI({ status: vi.fn(async () => ({ ...接続済みのbot, missingScopes: ['user:write:chat'] })) })
    render(<BotPage api={api} />)

    expect(await お知らせ('user:write:chat')).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: /接続/ })).toBeInTheDocument()
  })

  test('状態を読めなければ、理由を出す（黙って未接続扱いにしない）', async () => {
    const api = 代役のAPI({
      status: vi.fn(async () => {
        throw new Error('ログインが必要です')
      }),
    })
    render(<BotPage api={api} />)

    expect(await お知らせ('ログインが必要です')).toBeInTheDocument()
  })
})

describe('切断', () => {
  test('確認してから切断し、未接続の表示に変わる', async () => {
    const api = 代役のAPI()
    render(<BotPage api={api} />)
    await screen.findByText(/haishinsha_bot/)

    await userEvent.click(screen.getByRole('button', { name: 'botを切断する' }))
    const dialog = await screen.findByRole('alertdialog')
    // 確認するまでは切断しない
    expect(api.disconnect).not.toHaveBeenCalled()

    await userEvent.click(within(dialog).getByRole('button', { name: '切断する' }))

    expect(api.disconnect).toHaveBeenCalled()
    expect(await screen.findByRole('link', { name: /接続/ })).toBeInTheDocument()
  })

  test('確認でやめたら、切断しない', async () => {
    const api = 代役のAPI()
    render(<BotPage api={api} />)
    await screen.findByText(/haishinsha_bot/)

    await userEvent.click(screen.getByRole('button', { name: 'botを切断する' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'やめる' }))

    expect(api.disconnect).not.toHaveBeenCalled()
  })
})

describe('テスト送信', () => {
  test('入力した本文をWorkerへ送り、送れたことを知らせる', async () => {
    const api = 代役のAPI()
    render(<BotPage api={api} />)
    await screen.findByText(/haishinsha_bot/)

    await userEvent.type(screen.getByLabelText('テスト送信する文言'), 'こんばんは、配信が始まりました')
    await userEvent.click(screen.getByRole('button', { name: '送信する' }))

    expect(api.sendMessage).toHaveBeenCalledWith('こんばんは、配信が始まりました')
    expect(await お知らせ('送信しました')).toBeInTheDocument()
  })

  test('送信中にEnterを押しても、二重に送らない', async () => {
    let 送信を終える = (): void => {}
    const api = 代役のAPI({
      sendMessage: vi.fn(
        async () =>
          new Promise<void>((resolve) => {
            送信を終える = resolve
          }),
      ),
    })
    render(<BotPage api={api} />)
    await screen.findByText(/haishinsha_bot/)

    const 入力欄 = screen.getByLabelText('テスト送信する文言')
    await userEvent.type(入力欄, 'こんばんは{Enter}')
    // 1回目の送信が終わらないうちに、もう一度Enterを押す
    await userEvent.type(入力欄, '{Enter}')

    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    送信を終える()
  })

  test('本文が空なら、Workerへ送らずに入力を促す', async () => {
    const api = 代役のAPI()
    render(<BotPage api={api} />)
    await screen.findByText(/haishinsha_bot/)

    await userEvent.click(screen.getByRole('button', { name: '送信する' }))

    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(await お知らせ('文言を入力してください')).toBeInTheDocument()
  })

  test('送信に失敗したら、理由を出す', async () => {
    const api = 代役のAPI({
      sendMessage: vi.fn(async () => {
        throw new Error('Twitchがチャットを送信しませんでした: メッセージがAutoModに保留されました')
      }),
    })
    render(<BotPage api={api} />)
    await screen.findByText(/haishinsha_bot/)

    await userEvent.type(screen.getByLabelText('テスト送信する文言'), 'あやしい文言')
    await userEvent.click(screen.getByRole('button', { name: '送信する' }))

    expect(await お知らせ('AutoMod')).toBeInTheDocument()
  })

  test('未接続なら、テスト送信の欄を出さない', async () => {
    render(<BotPage api={代役のAPI({ status: vi.fn(async () => null) })} />)
    await screen.findByRole('link', { name: /接続/ })

    expect(screen.queryByLabelText('テスト送信する文言')).not.toBeInTheDocument()
  })
})
