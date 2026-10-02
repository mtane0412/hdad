// @vitest-environment jsdom
/**
 * 拡張の設定ページ（映さないサイトの管理）のテスト
 *
 * サービスワーカーへの頼みは偽物に差し替え、次を確かめる。
 * - 開いたら一覧を出す。登録が無ければそう出す
 * - ホスト名を入力して登録すると、一覧に加わり入力欄が空になる
 * - 消すと一覧から外れる
 * - 失敗したら理由を出す（Worker が形の違うホスト名を拒んだときなど）。入力は消さない
 */
import { screen, waitFor } from '@testing-library/dom'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { mountOptionsPage } from './options-page'
import type { SettingsReply, SettingsRequest } from './settings-request'

afterEach(() => {
  document.body.replaceChildren()
})

/** 一覧を覚えておき、頼みに応じて変える偽物のサービスワーカー */
const createFakeServiceWorker = (initial: string[], failures: Partial<Record<SettingsRequest['type'], string>> = {}) => {
  let hosts = [...initial]
  const requests: SettingsRequest[] = []
  const send = async (request: SettingsRequest): Promise<SettingsReply> => {
    requests.push(request)
    const failure = failures[request.type]
    if (failure !== undefined) return { ok: false, message: failure }
    if (request.type === 'add') hosts = [...hosts, request.host]
    if (request.type === 'remove') hosts = hosts.filter((host) => host !== request.host)
    return { ok: true, hosts }
  }
  return { send, requests }
}

describe('mountOptionsPage', () => {
  it('開いたら一覧を出す', async () => {
    const { send } = createFakeServiceWorker(['mail.google.com', 'bank.example.jp'])

    mountOptionsPage(document.body, send)

    expect(await screen.findByText('mail.google.com')).toBeTruthy()
    expect(screen.getByText('bank.example.jp')).toBeTruthy()
  })

  it('登録が無ければ、そう出す', async () => {
    const { send } = createFakeServiceWorker([])

    mountOptionsPage(document.body, send)

    expect(await screen.findByText('まだ登録していません。')).toBeTruthy()
  })

  it('ホスト名を入力して登録すると、一覧に加わり入力欄が空になる', async () => {
    const { send, requests } = createFakeServiceWorker([])
    mountOptionsPage(document.body, send)
    await screen.findByText('まだ登録していません。')

    const input = screen.getByLabelText('映さないサイトのホスト名')
    await userEvent.type(input, ' bank.example.jp ')
    await userEvent.click(screen.getByRole('button', { name: '登録する' }))

    expect(await screen.findByText('bank.example.jp')).toBeTruthy()
    expect(requests.at(-1)).toEqual({ type: 'add', host: 'bank.example.jp' })
    expect((input as HTMLInputElement).value).toBe('')
  })

  it('消すと一覧から外れる', async () => {
    const { send, requests } = createFakeServiceWorker(['mail.google.com'])
    mountOptionsPage(document.body, send)

    await userEvent.click(await screen.findByRole('button', { name: 'mail.google.com を一覧から消す' }))

    await waitFor(() => expect(screen.queryByText('mail.google.com')).toBeNull())
    expect(requests.at(-1)).toEqual({ type: 'remove', host: 'mail.google.com' })
  })

  it('登録できなければ理由を出し、入力は消さない', async () => {
    const reason = '映さないサイトに問題があります: host: ホスト名（例: mail.google.com）だけを、小文字で、ポートやパスを付けずに指定してください'
    const { send } = createFakeServiceWorker([], { add: reason })
    mountOptionsPage(document.body, send)
    await screen.findByText('まだ登録していません。')

    const input = screen.getByLabelText('映さないサイトのホスト名')
    await userEvent.type(input, 'https://bank.example.jp/')
    await userEvent.click(screen.getByRole('button', { name: '登録する' }))

    expect((await screen.findByRole('alert')).textContent).toBe(reason)
    expect((input as HTMLInputElement).value).toBe('https://bank.example.jp/')
  })

  it('一覧を読めなければ理由を出す', async () => {
    const { send } = createFakeServiceWorker([], { list: 'Chrome で HDAD にログインしていません' })

    mountOptionsPage(document.body, send)

    expect((await screen.findByRole('alert')).textContent).toBe('Chrome で HDAD にログインしていません')
  })
})
