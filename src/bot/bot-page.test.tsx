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
import { ApiError } from '@/core/api'
import { BotPage } from './bot-page'
import type { BotApi, BotCommandItem, BotStatus, DevicePoll } from './api'

const 接続済みのbot: BotStatus = { userId: '67890', login: 'haishinsha_bot', missingScopes: [] }

/** botが接続済みのWorkerの代役 */
const 挨拶のコマンド: BotCommandItem = { name: 'aisatsu', reply: '@{user} こんばんは', cooldownSeconds: 10 }

const 発行されたコード = {
  deviceCode: 'device-code-0123456789',
  userCode: 'ABCDEFGH',
  verificationUri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH',
  expiresIn: 1800,
  // テストでは待ち時間を入れずに問い合わせ直す
  intervalSeconds: 0,
}

const 代役のAPI = (overrides: Partial<BotApi> = {}): BotApi => ({
  status: vi.fn(async () => 接続済みのbot),
  disconnect: vi.fn(async () => {}),
  sendMessage: vi.fn(async () => {}),
  startDeviceCode: vi.fn(async () => 発行されたコード),
  commands: vi.fn(async () => [挨拶のコマンド]),
  saveCommands: vi.fn(async (commands: readonly BotCommandItem[]) => [...commands]),
  pollDeviceCode: vi.fn(async (): Promise<DevicePoll> => ({ status: 'connected', bot: 接続済みのbot })),
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

describe('別の端末での接続（デバイスコードフロー）', () => {
  /** 未接続の状態から始める代役。デバイスコードの部分だけ差し替えられる */
  const 未接続のAPI = (overrides: Partial<BotApi> = {}): BotApi => 代役のAPI({ status: vi.fn(async () => null), ...overrides })

  test('コードと案内先を出す', async () => {
    const api = 未接続のAPI({ pollDeviceCode: vi.fn(async (): Promise<DevicePoll> => ({ status: 'pending' })) })
    render(<BotPage api={api} />)

    await userEvent.click(await screen.findByRole('button', { name: '別の端末で接続する' }))

    expect(await screen.findByText('ABCDEFGH')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /twitch\.tv\/activate/ })).toHaveAttribute('href', 発行されたコード.verificationUri)
  })

  test('認可が済んだら、接続済みの表示に切り替わる', async () => {
    const api = 未接続のAPI()
    render(<BotPage api={api} />)

    await userEvent.click(await screen.findByRole('button', { name: '別の端末で接続する' }))

    // お知らせの文にもログイン名が出るので、アカウント名だけの要素を厳密に探す
    expect(await screen.findByText('haishinsha_bot', { exact: true })).toBeInTheDocument()
    expect(api.pollDeviceCode).toHaveBeenCalledWith('device-code-0123456789')
  })

  test('認可されるまで、繰り返し問い合わせる', async () => {
    let 認可済み = false
    const api = 未接続のAPI({
      pollDeviceCode: vi.fn(async (): Promise<DevicePoll> => {
        if (!認可済み) {
          認可済み = true
          return { status: 'pending' }
        }
        return { status: 'connected', bot: 接続済みのbot }
      }),
    })
    render(<BotPage api={api} />)

    await userEvent.click(await screen.findByRole('button', { name: '別の端末で接続する' }))

    expect(await screen.findByText('haishinsha_bot', { exact: true })).toBeInTheDocument()
    expect(api.pollDeviceCode).toHaveBeenCalledTimes(2)
  })

  test('コードの期限が切れたら、やり直しを促す（黙って待ち続けない）', async () => {
    const api = 未接続のAPI({
      pollDeviceCode: vi.fn(async () => {
        throw new Error('Twitchが 400 を返しました: expired_token')
      }),
    })
    render(<BotPage api={api} />)

    await userEvent.click(await screen.findByRole('button', { name: '別の端末で接続する' }))

    expect(await お知らせ('expired_token')).toBeInTheDocument()
    // 待ち続けずに、コードの表示をやめる
    expect(screen.queryByText('ABCDEFGH')).not.toBeInTheDocument()
  })

  test('コードの発行に失敗したら、理由を出す', async () => {
    const api = 未接続のAPI({
      startDeviceCode: vi.fn(async () => {
        throw new Error('Twitchが 400 を返しました: invalid client')
      }),
    })
    render(<BotPage api={api} />)

    await userEvent.click(await screen.findByRole('button', { name: '別の端末で接続する' }))

    expect(await お知らせ('invalid client')).toBeInTheDocument()
  })
})

describe('コマンドの編集', () => {
  test('保存済みのコマンドを入力欄に出す', async () => {
    render(<BotPage api={代役のAPI()} />)

    expect(await screen.findByDisplayValue('aisatsu')).toBeInTheDocument()
    expect(screen.getByDisplayValue('@{user} こんばんは')).toBeInTheDocument()
    expect(screen.getByDisplayValue('10')).toBeInTheDocument()
  })

  test('コマンドを足して保存すると、入力した値がWorkerへ送られる', async () => {
    const api = 代役のAPI({ commands: vi.fn(async () => []) })
    render(<BotPage api={api} />)
    await screen.findByRole('button', { name: 'コマンドを足す' })

    await userEvent.click(screen.getByRole('button', { name: 'コマンドを足す' }))
    await userEvent.type(screen.getByLabelText('1番目のコマンド名'), 'discord')
    await userEvent.type(screen.getByLabelText('1番目の応答文'), 'Discordはこちらです')
    await userEvent.click(screen.getByRole('button', { name: 'コマンドを保存する' }))

    expect(api.saveCommands).toHaveBeenCalledWith([{ name: 'discord', reply: 'Discordはこちらです', cooldownSeconds: 0 }])
    expect(await お知らせ('保存しました')).toBeInTheDocument()
  })

  test('コマンドを外して保存できる', async () => {
    const api = 代役のAPI()
    render(<BotPage api={api} />)
    await screen.findByDisplayValue('aisatsu')

    await userEvent.click(screen.getByRole('button', { name: '1番目のコマンドを外す' }))
    await userEvent.click(screen.getByRole('button', { name: 'コマンドを保存する' }))

    expect(api.saveCommands).toHaveBeenCalledWith([])
  })

  test('保存に失敗したら、問題点を何番目のコマンドかが分かる形で出す', async () => {
    const api = 代役のAPI({
      saveCommands: vi.fn(async () => {
        throw new ApiError(400, 'invalid-config', 'コマンドの設定に問題があります', [
          'commands[0].reply: 500文字以内の文字列で指定してください',
        ])
      }),
    })
    render(<BotPage api={api} />)
    await screen.findByDisplayValue('aisatsu')

    await userEvent.click(screen.getByRole('button', { name: 'コマンドを保存する' }))

    // 入力欄のラベルにも「1番目のコマンド」が出るので、問題点の行そのものを探す
    expect(await お知らせ('・1番目のコマンド reply: 500文字以内')).toBeInTheDocument()
  })

  test('コマンドの一覧を読めなければ、理由を出す（黙って空の一覧にしない）', async () => {
    const api = 代役のAPI({
      commands: vi.fn(async () => {
        throw new Error('Workerに接続できません')
      }),
    })
    render(<BotPage api={api} />)

    expect(await お知らせ('Workerに接続できません')).toBeInTheDocument()
  })
})
