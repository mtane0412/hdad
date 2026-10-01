// @vitest-environment jsdom
/**
 * タブの映像のページ（/tab/）のテスト
 *
 * 取り込みと送信は拡張（extension/）の中で行うので、このページは拡張の入れ方と使い方を案内し、
 * 映さないサイトの一覧を見せて消せるようにする。Workerの呼び出しは偽物に差し替え、次を確かめる。
 * - Chrome 拡張をこの置き場所用にダウンロードできる
 * - 映しているタブでもう一度押すと止まることを案内する（このページを開いたままにする必要がないことも）
 * - 映さないサイトの一覧を出し、消せる。登録の仕方（ボタンの右クリック）を案内する
 * - 一覧を読めなければ、空の一覧と見分けがつくよう理由を出す
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { TabApi } from './api'
import { TabPage } from './tab-page'

afterEach(cleanup)

/** 一覧を覚えておき、消されたら外す偽物の呼び出し */
const createFakeTabApi = (initial: string[]): TabApi & { removed: string[] } => {
  let hosts = [...initial]
  const removed: string[] = []
  return {
    removed,
    loadBlockedHosts: async () => hosts,
    removeBlockedHost: async (host) => {
      removed.push(host)
      hosts = hosts.filter((entry) => entry !== host)
      return hosts
    },
  }
}

describe('TabPage', () => {
  it('Chrome 拡張をダウンロードできる', () => {
    // 拡張には、ダウンロードしたときの置き場所が書き込まれる（worker/tab-extension.ts）
    render(<TabPage api={createFakeTabApi([])} />)

    expect(screen.getByRole('link', { name: '拡張をダウンロード' }).getAttribute('href')).toBe('/api/admin/tab/extension.zip')
  })

  it('映し方と止め方を案内する', () => {
    render(<TabPage api={createFakeTabApi([])} />)

    expect(screen.getByText('映しているタブでもう一度押すと、映すのをやめます')).toBeTruthy()
    expect(screen.getByText(/このページは開いておかなくてかまいません/)).toBeTruthy()
  })

  it('映さないサイトの一覧を出し、消したサイトは一覧から外れる', async () => {
    const api = createFakeTabApi(['mail.google.com', 'bank.example.jp'])
    render(<TabPage api={api} />)

    expect(await screen.findByText('mail.google.com')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'mail.google.com を一覧から消す' }))

    await waitFor(() => expect(screen.queryByText('mail.google.com')).toBeNull())
    expect(api.removed).toEqual(['mail.google.com'])
    expect(screen.getByText('bank.example.jp')).toBeTruthy()
  })

  it('登録が無ければ、登録の仕方を案内する', async () => {
    render(<TabPage api={createFakeTabApi([])} />)

    expect(await screen.findByText(/まだ登録していません/)).toBeTruthy()
    expect(screen.getByText(/拡張のボタンを右クリックして「このサイトを映さない」/)).toBeTruthy()
  })

  it('一覧を読めなければ理由を出す', async () => {
    const api: TabApi = {
      loadBlockedHosts: async () => {
        throw new Error('ログインが必要です')
      },
      removeBlockedHost: async () => [],
    }
    render(<TabPage api={api} />)

    expect(await screen.findByText('ログインが必要です')).toBeTruthy()
  })
})
