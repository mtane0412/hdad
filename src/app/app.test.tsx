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
 * - 未保存の変更があるページから離れようとすると確認を出し、「留まる」なら編集した内容を残すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import type { AdminApi, Me } from '@/admin/api'
import type { BgmApi } from '@/bgm/api'
import type { PomodoroApi } from '@/pomodoro/api'
import type { BotApi, ModerationSettings } from '@/bot/api'
import type { OverlayLayoutAdminApi } from '@/overlay/admin-api'
import type { LlmApi } from '@/llm/api'
import type { DrawApi } from '@/draw/api'
import type { CommentApi } from '@/comments/api'
import type { FocusApi } from '@/focus/api'
import type { ScreenAdminApi } from '@/screen/api'
import type { SpeechApi } from '@/speech/api'
import type { StatsApi } from '@/stats/api'
import type { RecognitionDeps } from '@/transcript/recognition-context'
import type { ViewerApi } from '@/viewers/api'
import { App } from './app'

const broadcaster: Me = { userId: '12345', login: 'haishin_taro', overlayKey: 'overlay-key' }

const createFakeAdminApi = (me: AdminApi['me']): AdminApi => ({
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
  createReward: vi.fn(async () => {
    throw new Error('このテストでは報酬を変更しません')
  }),
  updateReward: vi.fn(async () => {
    throw new Error('このテストでは報酬を変更しません')
  }),
  removeReward: vi.fn(async () => {}),
})

/** 記録が空の代役。ダッシュボードはこの記録を読むが、この枠のテストでは中身を確かめない */
const createFakeBotApi: BotApi = {
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

const createFakeRecordApi: StatsApi = {
  sessions: vi.fn(async () => []),
  session: vi.fn(async () => {
    throw new Error('このテストでは配信の詳細を読みません')
  }),
  followers: vi.fn(async () => []),
}

const createFakeViewerApi: ViewerApi = {
  list: vi.fn(async () => []),
  saveNote: vi.fn(async () => {
    throw new Error('このテストではメモを保存しません')
  }),
  remove: vi.fn(async () => {}),
}

const createFakeBgmApi: BgmApi = {
  load: vi.fn(async () => ({ tracks: [], playback: { mediaId: null, volume: 0.3, repeat: false, shuffle: false }, settings: { judgeWithJev: false } })),
  saveTracks: vi.fn(async () => []),
  savePlayback: vi.fn(async () => ({ mediaId: null, volume: 0.3, repeat: false, shuffle: false })),
  skip: vi.fn(async () => ({ mediaId: null, volume: 0.3, repeat: false, shuffle: false })),
  saveSettings: vi.fn(async () => ({ judgeWithJev: false })),
}

const createFakePomodoroApi: PomodoroApi = {
  read: vi.fn(async () => ({ timer: null, settings: { breakMediaId: null } })),
  saveSettings: vi.fn(async (settings) => settings),
  control: vi.fn(async () => null),
}

const createFakeOverlayApi: OverlayLayoutAdminApi = {
  load: vi.fn(async () => []),
  save: vi.fn(async () => []),
}

const fakeLlmApi: LlmApi = {
  load: vi.fn(async () => {
    const lightModels = { 'workers-ai': '@cf/meta/llama-3.1-8b-instruct-fp8', openrouter: 'meta-llama/llama-3.1-8b-instruct' }
    const usageSetting = { provider: 'workers-ai' as const, models: lightModels }
    return {
      settings: {
        usages: {
          translation: usageSetting,
          aiChat: usageSetting,
          sideSuper: usageSetting,
          viewerSummary: usageSetting,
          streamSummary: {
            provider: 'workers-ai' as const,
            models: { 'workers-ai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast', openrouter: 'meta-llama/llama-3.3-70b-instruct' },
          },
        },
      },
      apiKeyConfigured: true,
    }
  }),
  save: vi.fn(async (settings) => settings),
  listModels: vi.fn(async () => [{ id: '@cf/meta/llama-3.1-8b-instruct-fp8', name: 'Llama 3.1 8B Instruct（fp8）' }]),
  // まだ一度もLLMを呼んでいない状態（使用状況の表示はこのテストでは問わない）
  loadUsage: vi.fn(async () => []),
  loadCredits: vi.fn(async () => ({ totalCredits: 0, totalUsage: 0, remaining: 0 })),
  loadTranslation: vi.fn(async () => ({ provider: 'off' as const, deeplKeyConfigured: false })),
  saveTranslation: vi.fn(async (provider) => provider),
  loadDeeplUsage: vi.fn(async () => ({ characterCount: 0, characterLimit: 500_000 })),
}

const createFakeFocusApi: FocusApi = {
  load: vi.fn(async () => null),
  save: vi.fn(async () => null),
}

const createFakeCommentApi: CommentApi = {
  loadIcons: vi.fn(async () => ({})),
  loadBadges: vi.fn(async () => new Map()),
  moderate: vi.fn(async (action) => ({ action })),
  send: vi.fn(async () => {}),
  markGreeted: vi.fn(async () => {}),
}

const createFakeDrawApi: DrawApi = {
  load: vi.fn(async () => ({ strokes: [] })),
  save: vi.fn(async () => {}),
  loadBackground: vi.fn(async () => ({ kind: 'none' as const })),
}

const createFakeScreenApi: ScreenAdminApi = {
  load: vi.fn(async () => ({ host: 'localhost', port: 4455, password: '', intervalSeconds: 60, collectionId: '' })),
  save: vi.fn(async (settings) => settings),
}

const createFakeSpeechApi: SpeechApi = {
  load: vi.fn(async () => ({ engine: 'local' as const, host: 'localhost', port: 50021, speaker: 3, speed: 1, volume: 1, maxLength: 60, readName: false, ignoreLogins: [] })),
  save: vi.fn(async (settings) => settings),
}

/** ページを開いた状態を作る（jsdom では実際の読み込みは起きない） */
const openPage = (path: string): void => window.history.replaceState(null, '', path)

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
  // jsdom には ResizeObserver がない。オーバーレイのプレビューが縮小率を決めるのに使うので、何もしない代役を置く
  // （ページを探す窓（cmdk）は一覧の高さを測るのに unobserve も呼ぶ）
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
  // jsdom には scrollIntoView がない。ページを探す窓が選んでいる項目を見える位置へ送るのに使う
  Element.prototype.scrollIntoView = () => {}
})

afterEach(() => {
  cleanup()
  openPage('/')
})

/**
 * 音声認識の代役。このブラウザには音声認識が無いものとし、オン・オフは recognitionSetting から読む。
 * 前提: 既定ではオフ（文字起こしを使っていない配信者）
 */
const createRecognitionDeps = (recognitionSetting: string | null = null): RecognitionDeps => ({
  api: { send: () => Promise.resolve(true) },
  translation: { translate: () => Promise.resolve(null) },
  createRecognition: null,
  openMicrophone: () => Promise.reject(new Error('このテストではマイクを開きません')),
  locks: { request: () => Promise.reject(new Error('このテストでは鍵を取りません')) },
  storage: { getItem: () => recognitionSetting, setItem: () => {} },
  connectCaption: () => ({ send: () => true, close: () => {} }),
})

describe('ログインしていないとき', () => {
  test('Twitchログインへのリンクだけを出し、サイドバーは出さない', async () => {
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} pomodoroApi={createFakePomodoroApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => null)} />)

    const login = await screen.findByRole('link', { name: 'Twitchでログイン' })
    expect(login).toHaveAttribute('href', '/api/auth/login')
    expect(screen.queryByRole('navigation', { name: 'サイト内の移動' })).not.toBeInTheDocument()
  })

  test('アプリ名と正式名称を出す', async () => {
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} pomodoroApi={createFakePomodoroApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => null)} />)

    expect(await screen.findByText('HDAD')).toBeInTheDocument()
    expect(screen.getByText('Hyperfocus-Driven Assistant Director')).toBeInTheDocument()
  })
})

describe('ログインしているとき', () => {
  test('文字起こしをオンにしてあれば、どのページでもサイドバーに状態を出し、押すとコネクターのページへ移る', async () => {
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} pomodoroApi={createFakePomodoroApi} recognitionDeps={createRecognitionDeps('on')} api={createFakeAdminApi(async () => broadcaster)} />)

    const status = await screen.findByRole('link', { name: '文字起こし: このブラウザでは使えません' })
    expect(status).toHaveAttribute('href', '/connectors/')
  })

  test('文字起こしをオフにしてあれば、サイドバーに状態を出さない', async () => {
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} pomodoroApi={createFakePomodoroApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => broadcaster)} />)

    await screen.findByRole('navigation', { name: 'サイト内の移動' })
    expect(screen.queryByText(/^文字起こし:/)).not.toBeInTheDocument()
  })

  test('サイドバーに配信者の名前と各ページへのリンクを出す', async () => {
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} pomodoroApi={createFakePomodoroApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => broadcaster)} />)

    const nav = await screen.findByRole('navigation', { name: 'サイト内の移動' })
    expect(nav).toBeInTheDocument()
    expect(screen.getByText('haishin_taro')).toBeInTheDocument()
    expect(screen.getByText('HDAD')).toBeInTheDocument()
    for (const [name, href] of [
      ['ダッシュボード', '/'],
      ['オーバーレイ', '/overlay/'],
      ['視聴者', '/viewers/'],
      ['アップロード', '/media/'],
      ['コネクター', '/connectors/'],
      ['ポモドーロ', '/pomodoro/'],
    ] as const) {
      expect(screen.getByRole('link', { name })).toHaveAttribute('href', href)
    }
    // 読み上げ・文字起こし・画面の取り込み・タブの映像はコネクターのページにまとめたので、サイドバーには出さない
    for (const name of ['読み上げ', '文字起こし', '画面の取り込み', 'タブの映像', '裏方']) {
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument()
    }
  })

  test('ログアウトすると、ログインの入口に戻る', async () => {
    const api = createFakeAdminApi(async () => broadcaster)
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} pomodoroApi={createFakePomodoroApi} recognitionDeps={createRecognitionDeps()} api={api} />)

    await userEvent.click(await screen.findByRole('button', { name: 'ログアウト' }))

    expect(api.logout).toHaveBeenCalledOnce()
    expect(await screen.findByRole('link', { name: 'Twitchでログイン' })).toBeInTheDocument()
  })
})

describe('ページの移動', () => {
  test('サイドバーのリンクを押すと、再読み込みなしでページが切り替わり、現在地の印が付け替わる', async () => {
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} pomodoroApi={createFakePomodoroApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => broadcaster)} />)
    expect(await screen.findByRole('link', { name: 'ダッシュボード' })).toHaveAttribute('aria-current', 'page')

    await userEvent.click(screen.getByRole('link', { name: 'アップロード' }))

    expect(window.location.pathname).toBe('/media/')
    expect(screen.getByRole('heading', { level: 1, name: 'アップロード' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'アップロード' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'ダッシュボード' })).not.toHaveAttribute('aria-current')
  })

  test('ブラウザの「戻る」で、前のページに戻る', async () => {
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} pomodoroApi={createFakePomodoroApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => broadcaster)} />)
    await userEvent.click(await screen.findByRole('link', { name: '視聴者' }))
    expect(screen.getByRole('heading', { level: 1, name: '視聴者' })).toBeInTheDocument()

    window.history.back()

    expect(await screen.findByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeInTheDocument()
  })

  test('ページUIのURLを直接開くと、そのページが出る', async () => {
    openPage('/triggers/')
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} pomodoroApi={createFakePomodoroApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => broadcaster)} />)

    expect(await screen.findByRole('heading', { level: 1, name: 'トリガー' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'トリガー' })).toHaveAttribute('aria-current', 'page')
  })

  test('末尾のスラッシュがないURLでも、同じページが出る', async () => {
    openPage('/media')
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} pomodoroApi={createFakePomodoroApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => broadcaster)} />)

    expect(await screen.findByRole('heading', { level: 1, name: 'アップロード' })).toBeInTheDocument()
  })

  test('未ログインでページUIのURLを開くと、ログインの入口だけが出る', async () => {
    openPage('/media/')
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} pomodoroApi={createFakePomodoroApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => null)} />)

    expect(await screen.findByRole('link', { name: 'Twitchでログイン' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1, name: 'アップロード' })).not.toBeInTheDocument()
  })

  test('存在しないパスでは、見つからないことを伝え、ダッシュボードへ戻れる', async () => {
    openPage('/nai-page/')
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} pomodoroApi={createFakePomodoroApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => broadcaster)} />)

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
        statsApi={createFakeRecordApi}
        botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} pomodoroApi={createFakePomodoroApi} recognitionDeps={createRecognitionDeps()}
        api={createFakeAdminApi(async () => {
          throw new Error('Workerに接続できません')
        })}
      />,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('Workerに接続できません')
    expect(screen.queryByRole('link', { name: 'Twitchでログイン' })).not.toBeInTheDocument()
  })
})

/** ログイン済みの配信者としてアプリを開く */
const renderSignedIn = () =>
  render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} pomodoroApi={createFakePomodoroApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => broadcaster)} />)

describe('迷わず移動できること', () => {
  test('サイドバーの項目を、使う場面ごとのまとまりに分けて並べる', async () => {
    renderSignedIn()
    await screen.findByRole('link', { name: 'ダッシュボード' })

    for (const label of ['配信中', '配信画面', '自動化', '素材']) {
      expect(screen.getByText(label, { selector: '[data-slot="sidebar-group-label"]' })).toBeInTheDocument()
    }
  })

  test('ブラウザのタブの題名に、いま開いているページの名前を出す', async () => {
    openPage('/viewers/')
    renderSignedIn()
    await screen.findByRole('heading', { level: 1, name: '視聴者' })
    expect(document.title).toBe('視聴者 · HDAD')

    await userEvent.click(within(screen.getByRole('navigation', { name: 'サイト内の移動' })).getByRole('link', { name: 'アップロード' }))
    expect(document.title).toBe('アップロード · HDAD')
  })

  test('ログアウトしてログインの入口に戻ったら、タブの題名をアプリ名だけに戻す', async () => {
    openPage('/viewers/')
    renderSignedIn()
    await screen.findByRole('heading', { level: 1, name: '視聴者' })

    await userEvent.click(screen.getByRole('button', { name: 'ログアウト' }))

    expect(await screen.findByRole('link', { name: 'Twitchでログイン' })).toBeInTheDocument()
    expect(document.title).toBe('HDAD')
  })

  test('キーボードで操作する人のために、サイドバーを飛ばして本文へ移るリンクを置く', async () => {
    renderSignedIn()
    const skip = await screen.findByRole('link', { name: '本文へ移動' })
    expect(skip).toHaveAttribute('href', '#main')
    expect(document.getElementById('main')).toBeInTheDocument()
  })

  test('ページを移ったら、読み上げソフトが新しいページの見出しから読めるよう、見出しへフォーカスを移す', async () => {
    renderSignedIn()
    await userEvent.click(await screen.findByRole('link', { name: '視聴者' }))
    expect(screen.getByRole('heading', { level: 1, name: '視聴者' })).toHaveFocus()
  })

  test('Cmd+K でページを探す窓が開き、名前の一部を打って Enter でそのページへ移る', async () => {
    renderSignedIn()
    await screen.findByRole('link', { name: 'ダッシュボード' })

    await userEvent.keyboard('{Meta>}k{/Meta}')
    const dialog = await screen.findByRole('dialog', { name: 'ページを移動' })
    expect(dialog).toBeInTheDocument()

    await userEvent.keyboard('トリガ')
    await userEvent.keyboard('{Enter}')

    expect(await screen.findByRole('heading', { level: 1, name: 'トリガー' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/triggers/')
    expect(screen.queryByRole('dialog', { name: 'ページを移動' })).not.toBeInTheDocument()
  })

  test('見出しの横のボタンからも、ページを探す窓を開ける', async () => {
    renderSignedIn()
    await userEvent.click(await screen.findByRole('button', { name: /ページを探す/ }))
    expect(await screen.findByRole('dialog', { name: 'ページを移動' })).toBeInTheDocument()
  })
})

describe('見出しで飛べること', () => {
  test('ログインの入口では、アプリ名をページの見出しにする', async () => {
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} pomodoroApi={createFakePomodoroApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => null)} />)

    expect(await screen.findByRole('heading', { level: 1, name: 'HDAD' })).toBeInTheDocument()
  })

  test('ページの中のまとまり（カード）の題名を、ページの見出しの1段下の見出しにする', async () => {
    openPage('/media/')
    renderSignedIn()

    expect(await screen.findByRole('heading', { level: 2, name: '素材' })).toBeInTheDocument()
  })
})

describe('ログインの確認に失敗したときの立て直し', () => {
  test('エラーと一緒に、もう一度確かめるボタンを出す', async () => {
    const me = vi.fn<AdminApi['me']>().mockRejectedValueOnce(new Error('Workerに接続できません')).mockResolvedValueOnce(broadcaster)
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} pomodoroApi={createFakePomodoroApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(me)} />)

    await userEvent.click(await screen.findByRole('button', { name: 'もう一度確かめる' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeInTheDocument()
  })
})

describe('未保存の変更があるままページを離れようとしたとき', () => {
  /** チャットボットのページを開き、自動モデレーションの有効・無効を切り替えて（保存せずに）おく */
  const editBotPageWithoutSaving = async () => {
    openPage('/bot/')
    renderSignedIn()
    const enabled = await screen.findByRole('checkbox', { name: '自動モデレーションを有効にする' })
    await userEvent.click(enabled)
    expect(enabled).toBeChecked()
  }

  test('サイドバーで移ろうとすると確認が出て、「留まる」を選べば編集した内容がそのまま残る', async () => {
    await editBotPageWithoutSaving()

    await userEvent.click(screen.getByRole('link', { name: 'ダッシュボード' }))

    const dialog = await screen.findByRole('alertdialog', { name: '保存していない変更があります' })
    await userEvent.click(within(dialog).getByRole('button', { name: '留まる' }))

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(window.location.pathname).toBe('/bot/')
    expect(screen.getByRole('heading', { level: 1, name: 'チャットボット' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '自動モデレーションを有効にする' })).toBeChecked()
  })

  test('確認で「保存せずに移る」を選べば、そのページへ移る', async () => {
    await editBotPageWithoutSaving()

    await userEvent.click(screen.getByRole('link', { name: 'ダッシュボード' }))
    const dialog = await screen.findByRole('alertdialog', { name: '保存していない変更があります' })
    await userEvent.click(within(dialog).getByRole('button', { name: '保存せずに移る' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
  })

  test('編集していなければ、確認を出さずにすぐ移る', async () => {
    openPage('/bot/')
    renderSignedIn()
    await screen.findByRole('checkbox', { name: '自動モデレーションを有効にする' })

    await userEvent.click(screen.getByRole('link', { name: 'ダッシュボード' }))

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeInTheDocument()
  })
})
