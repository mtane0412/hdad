// @vitest-environment jsdom
/**
 * アプリの枠（ログインの確認とサイドバー）のテスト
 *
 * 確かめること:
 * - ログインしていなければ、中身を出さずにTwitchログインへの入口だけを出すこと
 * - ログインしていれば、サイドバーに配信者の名前と各ページへのリンクを出すこと
 * - ログインの確認に失敗したら、黙って未ログイン扱いにせずエラーを出すこと
 * - ログアウトしたら、ログインの入口に戻ること
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import type { Me } from '@/admin/api'
import { App, type SessionApi } from './app'

const 配信者: Me = { userId: '12345', login: 'haishin_taro', overlayKey: 'overlay-key' }

const 代役のAPI = (me: SessionApi['me']): SessionApi => ({ me, logout: vi.fn(async () => {}) })

beforeAll(() => {
  // jsdom には matchMedia がない。サイドバーが画面幅の判定に使うので、常に「広い画面」と答える代役を置く
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })
})

afterEach(cleanup)

describe('ログインしていないとき', () => {
  test('Twitchログインへのリンクだけを出し、サイドバーは出さない', async () => {
    render(<App api={代役のAPI(async () => null)} />)

    const login = await screen.findByRole('link', { name: 'Twitchでログイン' })
    expect(login).toHaveAttribute('href', '/api/auth/login')
    expect(screen.queryByRole('navigation', { name: 'サイト内の移動' })).not.toBeInTheDocument()
  })
})

describe('ログインしているとき', () => {
  test('サイドバーに配信者の名前と各ページへのリンクを出す', async () => {
    render(<App api={代役のAPI(async () => 配信者)} />)

    const nav = await screen.findByRole('navigation', { name: 'サイト内の移動' })
    expect(nav).toBeInTheDocument()
    expect(screen.getByText('haishin_taro')).toBeInTheDocument()
    for (const [name, href] of [
      ['ダッシュボード', '/'],
      ['壁紙', '/wallpaper/'],
      ['時計', '/clock/'],
      ['チャット', '/chat/'],
      ['アラート', '/admin/'],
    ] as const) {
      expect(screen.getByRole('link', { name })).toHaveAttribute('href', href)
    }
  })

  test('ログアウトすると、ログインの入口に戻る', async () => {
    const api = 代役のAPI(async () => 配信者)
    render(<App api={api} />)

    await userEvent.click(await screen.findByRole('button', { name: 'ログアウト' }))

    expect(api.logout).toHaveBeenCalledOnce()
    expect(await screen.findByRole('link', { name: 'Twitchでログイン' })).toBeInTheDocument()
  })
})

describe('ログインの確認に失敗したとき', () => {
  test('未ログイン扱いにせず、エラーの内容を出す', async () => {
    render(
      <App
        api={代役のAPI(async () => {
          throw new Error('Workerに接続できません')
        })}
      />,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('Workerに接続できません')
    expect(screen.queryByRole('link', { name: 'Twitchでログイン' })).not.toBeInTheDocument()
  })
})
