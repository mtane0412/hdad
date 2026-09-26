// @vitest-environment jsdom
/**
 * アプリの枠（ログインの確認とサイドバー）のテスト
 *
 * 確かめること:
 * - ログインしていなければ、中身を出さずにTwitchログインへの入口だけを出すこと
 * - ログインの入口とサイドバーに、アプリ名（HDAD）と正式名称を出すこと
 * - ログインしていれば、サイドバーに配信者の名前と各ページへのリンクを出すこと
 * - ログインの確認に失敗したら、黙って未ログイン扱いにせずエラーを出すこと
 * - ログアウトしたら、ログインの入口に戻ること
 * - サイドバーのリンクで、再読み込みなしにページが切り替わり、現在地の印が付け替わること
 * - ページUIのURLを直接開いても、そのページが出ること（未ログインならログインの入口だけ）
 * - 存在しないパスでは、見つからないことを伝える画面を出すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import type { AdminApi, Me } from '@/admin/api'
import type { BotApi, ModerationSettings } from '@/bot/api'
import type { SpeechApi } from '@/speech/api'
import type { StatsApi } from '@/stats/api'
import type { ViewerApi } from '@/viewers/api'
import { App } from './app'

const 配信者: Me = { userId: '12345', login: 'haishin_taro', overlayKey: 'overlay-key' }

const 代役のAPI = (me: AdminApi['me']): AdminApi => ({
  me,
  logout: vi.fn(async () => {}),
  config: vi.fn(async () => []),
  saveConfig: vi.fn(async () => []),
  media: vi.fn(async () => []),
  upload: vi.fn(async () => {
    throw new Error('このテストではアップロードしません')
  }),
  removeMedia: vi.fn(async () => {}),
  rotateOverlayKey: vi.fn(async () => 'new-overlay-key'),
  rewards: vi.fn(async () => []),
})

/** 記録が空の代役。ダッシュボードはこの記録を読むが、この枠のテストでは中身を確かめない */
const 代役のbotAPI: BotApi = {
  status: vi.fn(async () => null),
  disconnect: vi.fn(async () => {}),
  sendMessage: vi.fn(async () => {}),
  startDeviceCode: vi.fn(async () => {
    throw new Error('このテストではデバイスコードを発行しません')
  }),
  pollDeviceCode: vi.fn(async () => {
    throw new Error('このテストでは認可を待ちません')
  }),
  commands: vi.fn(async () => []),
  saveCommands: vi.fn(async () => []),
  moderation: vi.fn(async () => ({ enabled: false, exemptBroadcaster: true, exemptVip: true, exemptSubscriber: true, rules: [] })),
  saveModeration: vi.fn(async (settings: ModerationSettings) => ({ ...settings })),
}

const 代役の記録API: StatsApi = {
  sessions: vi.fn(async () => []),
  session: vi.fn(async () => {
    throw new Error('このテストでは配信の詳細を読みません')
  }),
  followers: vi.fn(async () => []),
}

const 代役の視聴者API: ViewerApi = {
  list: vi.fn(async () => []),
  saveNote: vi.fn(async () => {
    throw new Error('このテストではメモを保存しません')
  }),
  remove: vi.fn(async () => {}),
}

const 代役の読み上げAPI: SpeechApi = {
  load: vi.fn(async () => ({ host: 'localhost', port: 50021, speaker: 3, speed: 1, volume: 1, maxLength: 60, readName: false, ignoreLogins: [] })),
  save: vi.fn(async (settings) => settings),
}

/** ページを開いた状態を作る（jsdom では実際の読み込みは起きない） */
const 開く = (path: string): void => window.history.replaceState(null, '', path)

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
  // jsdom には ResizeObserver がない。ギャラリーがプレビューの縮小率を決めるのに使うので、何もしない代役を置く
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  )
})

afterEach(() => {
  cleanup()
  開く('/')
})

describe('ログインしていないとき', () => {
  test('Twitchログインへのリンクだけを出し、サイドバーは出さない', async () => {
    render(<App statsApi={代役の記録API} botApi={代役のbotAPI} viewerApi={代役の視聴者API} speechApi={代役の読み上げAPI} api={代役のAPI(async () => null)} />)

    const login = await screen.findByRole('link', { name: 'Twitchでログイン' })
    expect(login).toHaveAttribute('href', '/api/auth/login')
    expect(screen.queryByRole('navigation', { name: 'サイト内の移動' })).not.toBeInTheDocument()
  })

  test('アプリ名と正式名称を出す', async () => {
    render(<App statsApi={代役の記録API} botApi={代役のbotAPI} viewerApi={代役の視聴者API} speechApi={代役の読み上げAPI} api={代役のAPI(async () => null)} />)

    expect(await screen.findByText('HDAD')).toBeInTheDocument()
    expect(screen.getByText('Hyperfocus-Driven Assistant Director')).toBeInTheDocument()
  })
})

describe('ログインしているとき', () => {
  test('サイドバーに配信者の名前と各ページへのリンクを出す', async () => {
    render(<App statsApi={代役の記録API} botApi={代役のbotAPI} viewerApi={代役の視聴者API} speechApi={代役の読み上げAPI} api={代役のAPI(async () => 配信者)} />)

    const nav = await screen.findByRole('navigation', { name: 'サイト内の移動' })
    expect(nav).toBeInTheDocument()
    expect(screen.getByText('haishin_taro')).toBeInTheDocument()
    expect(screen.getByText('HDAD')).toBeInTheDocument()
    for (const [name, href] of [
      ['ダッシュボード', '/'],
      ['壁紙', '/wallpaper/'],
      ['時計', '/clock/'],
      ['チャット', '/chat/'],
      ['アップロード', '/media/'],
    ] as const) {
      expect(screen.getByRole('link', { name })).toHaveAttribute('href', href)
    }
  })

  test('ログアウトすると、ログインの入口に戻る', async () => {
    const api = 代役のAPI(async () => 配信者)
    render(<App statsApi={代役の記録API} botApi={代役のbotAPI} viewerApi={代役の視聴者API} speechApi={代役の読み上げAPI} api={api} />)

    await userEvent.click(await screen.findByRole('button', { name: 'ログアウト' }))

    expect(api.logout).toHaveBeenCalledOnce()
    expect(await screen.findByRole('link', { name: 'Twitchでログイン' })).toBeInTheDocument()
  })
})

describe('ページの移動', () => {
  test('サイドバーのリンクを押すと、再読み込みなしでページが切り替わり、現在地の印が付け替わる', async () => {
    render(<App statsApi={代役の記録API} botApi={代役のbotAPI} viewerApi={代役の視聴者API} speechApi={代役の読み上げAPI} api={代役のAPI(async () => 配信者)} />)
    expect(await screen.findByRole('link', { name: 'ダッシュボード' })).toHaveAttribute('aria-current', 'page')

    await userEvent.click(screen.getByRole('link', { name: '壁紙' }))

    expect(window.location.pathname).toBe('/wallpaper/')
    expect(screen.getByRole('heading', { level: 1, name: '壁紙' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '壁紙' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'ダッシュボード' })).not.toHaveAttribute('aria-current')
  })

  test('ブラウザの「戻る」で、前のページに戻る', async () => {
    render(<App statsApi={代役の記録API} botApi={代役のbotAPI} viewerApi={代役の視聴者API} speechApi={代役の読み上げAPI} api={代役のAPI(async () => 配信者)} />)
    await userEvent.click(await screen.findByRole('link', { name: '時計' }))
    expect(screen.getByRole('heading', { level: 1, name: '時計' })).toBeInTheDocument()

    window.history.back()

    expect(await screen.findByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeInTheDocument()
  })

  test('ページUIのURLを直接開くと、そのページが出る', async () => {
    開く('/triggers/')
    render(<App statsApi={代役の記録API} botApi={代役のbotAPI} viewerApi={代役の視聴者API} speechApi={代役の読み上げAPI} api={代役のAPI(async () => 配信者)} />)

    expect(await screen.findByRole('heading', { level: 1, name: 'トリガー' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'トリガー' })).toHaveAttribute('aria-current', 'page')
  })

  test('末尾のスラッシュがないURLでも、同じページが出る', async () => {
    開く('/chat')
    render(<App statsApi={代役の記録API} botApi={代役のbotAPI} viewerApi={代役の視聴者API} speechApi={代役の読み上げAPI} api={代役のAPI(async () => 配信者)} />)

    expect(await screen.findByRole('heading', { level: 1, name: 'チャット' })).toBeInTheDocument()
  })

  test('未ログインでページUIのURLを開くと、ログインの入口だけが出る', async () => {
    開く('/wallpaper/')
    render(<App statsApi={代役の記録API} botApi={代役のbotAPI} viewerApi={代役の視聴者API} speechApi={代役の読み上げAPI} api={代役のAPI(async () => null)} />)

    expect(await screen.findByRole('link', { name: 'Twitchでログイン' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1, name: '壁紙' })).not.toBeInTheDocument()
  })

  test('存在しないパスでは、見つからないことを伝え、ダッシュボードへ戻れる', async () => {
    開く('/nai-page/')
    render(<App statsApi={代役の記録API} botApi={代役のbotAPI} viewerApi={代役の視聴者API} speechApi={代役の読み上げAPI} api={代役のAPI(async () => 配信者)} />)

    expect(await screen.findByRole('heading', { level: 1, name: 'ページが見つかりません' })).toBeInTheDocument()
    expect(screen.getByText('/nai-page/')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('link', { name: 'ダッシュボードへ戻る' }))
    expect(screen.getByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeInTheDocument()
  })
})

describe('ログインの確認に失敗したとき', () => {
  test('未ログイン扱いにせず、エラーの内容を出す', async () => {
    render(
      <App
        statsApi={代役の記録API}
        botApi={代役のbotAPI} viewerApi={代役の視聴者API} speechApi={代役の読み上げAPI}
        api={代役のAPI(async () => {
          throw new Error('Workerに接続できません')
        })}
      />,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('Workerに接続できません')
    expect(screen.queryByRole('link', { name: 'Twitchでログイン' })).not.toBeInTheDocument()
  })
})
