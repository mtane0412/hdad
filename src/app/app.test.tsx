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
 * - 下部バー（配信中の操作）に文字起こしのオン・オフと状態を出し、サイドバーには出さないこと
 * - 本文の上にバーを持たず、サイドバーの開閉と「ページを探す」をサイドバーの上部に置くこと
 * - 狭い画面では、閉じたサイドバーを下部バーから開けること
 * - WebMCP に対応したブラウザでは、ログインしているあいだだけエージェント向けのツールを登録し、登録できなければエラーを出すこと
 */
import type { TownTourNarration } from '@/town-tour/narration'
import type { TownTourSound } from '@/town-tour/sound'
import type { TwisterSound } from '@/twister/sound'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import type { AdminApi, Me } from '@/admin/api'
import type { BgmApi, BgmTrack } from '@/bgm/api'
import type { BgmConnect, BgmWatchHandlers } from '@/bgm/player-context'
import type { PomodoroApi } from '@/pomodoro/api'
import type { KanjiQuizStopDeps } from '@/kanji-quiz/stop-bar'
import type { PomodoroConnect } from '@/pomodoro/timer-context'
import type { TextApi } from '@/text/api'
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
import type { WebMCP } from 'webmcp-types'
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
  playTownTourDemo: vi.fn(async () => '試し再生: 本日は東京都千代田区をご紹介します'),
  playTwisterDemo: vi.fn(async () => 'レイドした人（試し） vs 配信者'),
  playKanjiQuizDemo: vi.fn(async () => '漢検6級「境内」'),
  townTourSound: vi.fn(async () => ({ slots: { bgm: null, opening: null, zoom: null, landing: null, item: null, closing: null }, bgmVolume: 0.3, effectVolume: 0.6 })),
  saveTownTourSound: vi.fn(async (sound: TownTourSound) => sound),
  twisterSound: vi.fn(async () => ({ bgm: null, bgmVolume: 0.3 })),
  saveTwisterSound: vi.fn(async (sound: TwisterSound) => sound),
  townTourNarration: vi.fn(async () => ({ enabled: false, speaker: 3, speed: 1 })),
  saveTownTourNarration: vi.fn(async (narration: TownTourNarration) => narration),
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
  titleSettings: vi.fn(async () => ({ enabled: false })),
  saveTitleSettings: vi.fn(async (settings) => settings),
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

/** BGMの押し出しにつながない代役（BGMを確かめないテストで使う） */
const connectNoBgm: BgmConnect = () => ({ close: () => undefined })

const createFakePomodoroApi: PomodoroApi = {
  read: vi.fn(async () => ({ timer: null, settings: { breakMediaId: null } })),
  saveSettings: vi.fn(async (settings) => settings),
  control: vi.fn(async () => null),
}

/** ポモドーロの押し出しにつながない代役 */
const connectNoPomodoro: PomodoroConnect = () => ({ close: () => undefined })
/** 漢字クイズの押し出しにつながず、取り消しも頼まない代役（下部バーの取り消しボタンは src/kanji-quiz/stop-bar.test.tsx が確かめる） */
const noKanjiQuizStop: KanjiQuizStopDeps = {
  connect: () => ({ close: () => undefined }),
  cancel: async () => [],
}
const createFakeTextApi: TextApi = { list: vi.fn(async () => []), create: vi.fn(), update: vi.fn(), remove: vi.fn() }

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
          streamTitle: {
            provider: 'workers-ai' as const,
            models: { 'workers-ai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast', openrouter: 'meta-llama/llama-3.3-70b-instruct' },
          },
          townTour: {
            provider: 'workers-ai' as const,
            models: { 'workers-ai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast', openrouter: 'meta-llama/llama-3.3-70b-instruct' },
          },
          townBond: {
            provider: 'openrouter' as const,
            models: { 'workers-ai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast', openrouter: 'google/gemini-3.8-flash' },
          },
          autoText: usageSetting,
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
  watchObsMute: () => ({ stop: () => {} }),
})

describe('ログインしていないとき', () => {
  test('Twitchログインへのリンクだけを出し、サイドバーは出さない', async () => {
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} connectBgm={connectNoBgm} connectPomodoro={connectNoPomodoro} kanjiQuizStop={noKanjiQuizStop} pomodoroApi={createFakePomodoroApi} textApi={createFakeTextApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => null)} />)

    const login = await screen.findByRole('link', { name: 'Twitchでログイン' })
    expect(login).toHaveAttribute('href', '/api/auth/login')
    expect(screen.queryByRole('navigation', { name: 'サイト内の移動' })).not.toBeInTheDocument()
  })

  test('アプリ名と正式名称を出す', async () => {
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} connectBgm={connectNoBgm} connectPomodoro={connectNoPomodoro} kanjiQuizStop={noKanjiQuizStop} pomodoroApi={createFakePomodoroApi} textApi={createFakeTextApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => null)} />)

    expect(await screen.findByText('HDAD')).toBeInTheDocument()
    expect(screen.getByText('Hyperfocus-Driven Assistant Director')).toBeInTheDocument()
  })
})

describe('ログインしているとき', () => {
  test('文字起こしをオンにしてあれば、どのページでも下部バーに状態を出し、押すとコネクターのページへ移る', async () => {
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} connectBgm={connectNoBgm} connectPomodoro={connectNoPomodoro} kanjiQuizStop={noKanjiQuizStop} pomodoroApi={createFakePomodoroApi} textApi={createFakeTextApi} recognitionDeps={createRecognitionDeps('on')} api={createFakeAdminApi(async () => broadcaster)} />)

    // 前提: このブラウザには音声認識が無い代役なので、状態は「使えません」になる
    const bar = await screen.findByRole('region', { name: '配信中の操作' })
    expect(within(bar).getByRole('button', { name: '文字起こし' })).toHaveAttribute('aria-pressed', 'true')
    // 音声認識が無いと分かるのは枠を描いたあとなので、状態が出るのを待つ
    expect(await within(bar).findByRole('link', { name: '文字起こしの様子: このブラウザでは使えません' })).toHaveAttribute('href', '/connectors/')
  })

  test('文字起こしをオフにしてあれば、下部バーにはオンにするボタンだけを出し、状態は出さない', async () => {
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} connectBgm={connectNoBgm} connectPomodoro={connectNoPomodoro} kanjiQuizStop={noKanjiQuizStop} pomodoroApi={createFakePomodoroApi} textApi={createFakeTextApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => broadcaster)} />)

    const bar = await screen.findByRole('region', { name: '配信中の操作' })
    expect(within(bar).getByRole('button', { name: '文字起こし' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('link', { name: /^文字起こしの様子/ })).not.toBeInTheDocument()
  })

  test('どのページでも下部バーにBGMのプレーヤーを出し、曲名から BGM のページへ移れる', async () => {
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} connectBgm={connectNoBgm} connectPomodoro={connectNoPomodoro} kanjiQuizStop={noKanjiQuizStop} pomodoroApi={createFakePomodoroApi} textApi={createFakeTextApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => broadcaster)} />)

    // 前提: 代役の BGM には曲が無く、止めている
    const bar = await screen.findByRole('region', { name: '配信中の操作' })
    expect(await within(bar).findByRole('link', { name: 'BGMを止めています' })).toHaveAttribute('href', '/bgm/')
    expect(within(bar).getByRole('button', { name: '再生' })).toBeDisabled()
  })

  test('どのページでも下部バーにポモドーロを出し、止めていれば始めるボタンを出す', async () => {
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} connectBgm={connectNoBgm} connectPomodoro={connectNoPomodoro} kanjiQuizStop={noKanjiQuizStop} pomodoroApi={createFakePomodoroApi} textApi={createFakeTextApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => broadcaster)} />)

    // 前提: 代役のポモドーロは止めている
    const bar = await screen.findByRole('region', { name: '配信中の操作' })
    expect(await within(bar).findByRole('button', { name: 'ポモドーロを始める' })).toBeInTheDocument()
  })

  test('BGM のページのプレーヤーと下部バーは、押し出された同じ曲を映す（押し出しの接続は1本だけ）', async () => {
    // 前提: 「ひだまりの午後」を流している。押し出しの接続の受け口を覚えておく
    const chatTrack: BgmTrack = { mediaId: 'media-zatsudan', title: 'ひだまりの午後', credit: '音楽: 甘茶の音楽工房', creditUrl: '', mood: '', scene: '' }
    const hypeTrack: BgmTrack = { mediaId: 'media-moriagari', title: '全力疾走', credit: '音楽: DOVA-SYNDROME', creditUrl: '', mood: '', scene: '' }
    const bgmApi: BgmApi = {
      ...createFakeBgmApi,
      load: vi.fn(async () => ({ tracks: [chatTrack, hypeTrack], playback: { mediaId: chatTrack.mediaId, volume: 0.3, repeat: false, shuffle: false }, settings: { judgeWithJev: false } })),
    }
    const connections: BgmWatchHandlers[] = []
    const connectBgm: BgmConnect = (_overlayKey, handlers) => {
      connections.push(handlers)
      return { close: () => undefined }
    }
    openPage('/bgm/')
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={bgmApi} connectBgm={connectBgm} connectPomodoro={connectNoPomodoro} kanjiQuizStop={noKanjiQuizStop} pomodoroApi={createFakePomodoroApi} textApi={createFakeTextApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => broadcaster)} />)
    const player = within(await screen.findByRole('region', { name: 'プレーヤー' }))
    const bar = within(screen.getByRole('region', { name: '配信中の操作' }))
    expect(player.getByText('ひだまりの午後')).toBeInTheDocument()
    expect(bar.getByRole('link', { name: 'ひだまりの午後' })).toBeInTheDocument()

    // 曲の終わりで「全力疾走」へ進んだことが押し出されてくる
    act(() =>
      connections[0]?.onMessage(
        JSON.stringify({ track: { mediaId: hypeTrack.mediaId, title: hypeTrack.title, credit: hypeTrack.credit, creditUrl: '', url: '/api/media/media-moriagari?key=k' }, volume: 0.3, repeat: false, shuffle: false }),
      ),
    )

    expect(connections).toHaveLength(1)
    expect(player.getByText('全力疾走')).toBeInTheDocument()
    expect(bar.getByRole('link', { name: '全力疾走' })).toBeInTheDocument()
  })

  test('文字起こしの状態は、サイドバーではなく下部バーだけに出す', async () => {
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} connectBgm={connectNoBgm} connectPomodoro={connectNoPomodoro} kanjiQuizStop={noKanjiQuizStop} pomodoroApi={createFakePomodoroApi} textApi={createFakeTextApi} recognitionDeps={createRecognitionDeps('on')} api={createFakeAdminApi(async () => broadcaster)} />)

    const account = await screen.findByRole('region', { name: 'アカウント' })
    expect(within(account).queryByText(/文字起こし/)).not.toBeInTheDocument()
  })

  test('サイドバーに配信者の名前と各ページへのリンクを出す', async () => {
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} connectBgm={connectNoBgm} connectPomodoro={connectNoPomodoro} kanjiQuizStop={noKanjiQuizStop} pomodoroApi={createFakePomodoroApi} textApi={createFakeTextApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => broadcaster)} />)

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
      ['テキスト', '/texts/'],
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
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} connectBgm={connectNoBgm} connectPomodoro={connectNoPomodoro} kanjiQuizStop={noKanjiQuizStop} pomodoroApi={createFakePomodoroApi} textApi={createFakeTextApi} recognitionDeps={createRecognitionDeps()} api={api} />)

    await userEvent.click(await screen.findByRole('button', { name: 'ログアウト' }))

    expect(api.logout).toHaveBeenCalledOnce()
    expect(await screen.findByRole('link', { name: 'Twitchでログイン' })).toBeInTheDocument()
  })
})

describe('ページの移動', () => {
  test('サイドバーのリンクを押すと、再読み込みなしでページが切り替わり、現在地の印が付け替わる', async () => {
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} connectBgm={connectNoBgm} connectPomodoro={connectNoPomodoro} kanjiQuizStop={noKanjiQuizStop} pomodoroApi={createFakePomodoroApi} textApi={createFakeTextApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => broadcaster)} />)
    expect(await screen.findByRole('link', { name: 'ダッシュボード' })).toHaveAttribute('aria-current', 'page')

    await userEvent.click(screen.getByRole('link', { name: 'アップロード' }))

    expect(window.location.pathname).toBe('/media/')
    expect(screen.getByRole('heading', { level: 1, name: 'アップロード' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'アップロード' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'ダッシュボード' })).not.toHaveAttribute('aria-current')
  })

  test('ブラウザの「戻る」で、前のページに戻る', async () => {
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} connectBgm={connectNoBgm} connectPomodoro={connectNoPomodoro} kanjiQuizStop={noKanjiQuizStop} pomodoroApi={createFakePomodoroApi} textApi={createFakeTextApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => broadcaster)} />)
    await userEvent.click(await screen.findByRole('link', { name: '視聴者' }))
    expect(screen.getByRole('heading', { level: 1, name: '視聴者' })).toBeInTheDocument()

    window.history.back()

    expect(await screen.findByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeInTheDocument()
  })

  test('ページUIのURLを直接開くと、そのページが出る', async () => {
    openPage('/triggers/')
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} connectBgm={connectNoBgm} connectPomodoro={connectNoPomodoro} kanjiQuizStop={noKanjiQuizStop} pomodoroApi={createFakePomodoroApi} textApi={createFakeTextApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => broadcaster)} />)

    expect(await screen.findByRole('heading', { level: 1, name: 'トリガー' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'トリガー' })).toHaveAttribute('aria-current', 'page')
  })

  test('末尾のスラッシュがないURLでも、同じページが出る', async () => {
    openPage('/media')
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} connectBgm={connectNoBgm} connectPomodoro={connectNoPomodoro} kanjiQuizStop={noKanjiQuizStop} pomodoroApi={createFakePomodoroApi} textApi={createFakeTextApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => broadcaster)} />)

    expect(await screen.findByRole('heading', { level: 1, name: 'アップロード' })).toBeInTheDocument()
  })

  test('未ログインでページUIのURLを開くと、ログインの入口だけが出る', async () => {
    openPage('/media/')
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} connectBgm={connectNoBgm} connectPomodoro={connectNoPomodoro} kanjiQuizStop={noKanjiQuizStop} pomodoroApi={createFakePomodoroApi} textApi={createFakeTextApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => null)} />)

    expect(await screen.findByRole('link', { name: 'Twitchでログイン' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1, name: 'アップロード' })).not.toBeInTheDocument()
  })

  test('存在しないパスでは、見つからないことを伝え、ダッシュボードへ戻れる', async () => {
    openPage('/nai-page/')
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} connectBgm={connectNoBgm} connectPomodoro={connectNoPomodoro} kanjiQuizStop={noKanjiQuizStop} pomodoroApi={createFakePomodoroApi} textApi={createFakeTextApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => broadcaster)} />)

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
        botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} connectBgm={connectNoBgm} connectPomodoro={connectNoPomodoro} kanjiQuizStop={noKanjiQuizStop} pomodoroApi={createFakePomodoroApi} textApi={createFakeTextApi} recognitionDeps={createRecognitionDeps()}
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
  render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} connectBgm={connectNoBgm} connectPomodoro={connectNoPomodoro} kanjiQuizStop={noKanjiQuizStop} pomodoroApi={createFakePomodoroApi} textApi={createFakeTextApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => broadcaster)} />)

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
    // 題名は見出しを描いたあとの effect で付く。ログインの確認（/api/me）は act の外で解決するので effect が遅れて走ることがあり、
    // CI の負荷が高いと見出しが出た直後にはまだ題名が変わっていない。付くのを待ってから確かめる
    await waitFor(() => expect(document.title).toBe('視聴者 · HDAD'))

    await userEvent.click(within(screen.getByRole('navigation', { name: 'サイト内の移動' })).getByRole('link', { name: 'アップロード' }))
    await waitFor(() => expect(document.title).toBe('アップロード · HDAD'))
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

  test('サイドバーの上部のボタンからも、ページを探す窓を開ける', async () => {
    renderSignedIn()
    const sidebarTop = await screen.findByRole('banner')
    await userEvent.click(within(sidebarTop).getByRole('button', { name: /ページを探す/ }))
    expect(await screen.findByRole('dialog', { name: 'ページを移動' })).toBeInTheDocument()
  })

  test('サイドバーの開閉ボタンを、サイドバーの上部に置く', async () => {
    renderSignedIn()
    const sidebarTop = await screen.findByRole('banner')
    expect(within(sidebarTop).getByRole('button', { name: 'サイドバーを開閉する' })).toBeInTheDocument()
  })

  test('下部バーは本文の外に置き、サイドバーの下まで画面の幅いっぱいに広げる（音楽プレーヤーの形）', async () => {
    renderSignedIn()
    const bar = await screen.findByRole('region', { name: '配信中の操作' })
    const sidebarTop = screen.getByRole('banner')
    expect(screen.getByRole('main')).not.toContainElement(bar)
    // サイドバーの中でもない（サイドバーはバーの上で終わる）
    expect(sidebarTop.closest('[data-slot="sidebar"]')).not.toContainElement(bar)
  })

  test('ページの見出しは本文の中に置く（本文の上に別のバーを持たない）', async () => {
    openPage('/viewers/')
    renderSignedIn()
    // ログインを確かめているあいだの画面も main を持つので、見出しが出てから本文を探す
    const heading = await screen.findByRole('heading', { level: 1, name: '視聴者' })
    const main = screen.getByRole('main')
    expect(main).toContainElement(heading)
    expect(main.querySelector('header')).toBeNull()
  })
})

describe('狭い画面', () => {
  const wideWidth = window.innerWidth

  afterEach(() => {
    window.innerWidth = wideWidth
  })

  test('サイドバーを閉じていても、下部バーのボタンから開ける', async () => {
    // 前提: スマホの幅。サイドバーは閉じた状態で始まり、サイト内の移動は見えない
    window.innerWidth = 500
    renderSignedIn()
    const bar = await screen.findByRole('region', { name: '配信中の操作' })
    // 画面の幅は描いたあとに判定されるので、開くボタンが出るのを待つ
    const opener = await within(bar).findByRole('button', { name: 'サイドバーを開く' })
    expect(screen.queryByRole('navigation', { name: 'サイト内の移動' })).not.toBeInTheDocument()

    await userEvent.click(opener)

    expect(await screen.findByRole('navigation', { name: 'サイト内の移動' })).toBeInTheDocument()
  })

  test('広い画面では、下部バーにサイドバーを開くボタンを出さない', async () => {
    renderSignedIn()
    const bar = await screen.findByRole('region', { name: '配信中の操作' })
    expect(within(bar).queryByRole('button', { name: 'サイドバーを開く' })).not.toBeInTheDocument()
  })
})

describe('見出しで飛べること', () => {
  test('ログインの入口では、アプリ名をページの見出しにする', async () => {
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} connectBgm={connectNoBgm} connectPomodoro={connectNoPomodoro} kanjiQuizStop={noKanjiQuizStop} pomodoroApi={createFakePomodoroApi} textApi={createFakeTextApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(async () => null)} />)

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
    render(<App statsApi={createFakeRecordApi} botApi={createFakeBotApi} viewerApi={createFakeViewerApi} speechApi={createFakeSpeechApi} screenApi={createFakeScreenApi} focusApi={createFakeFocusApi} commentApi={createFakeCommentApi} drawApi={createFakeDrawApi} llmApi={fakeLlmApi} overlayApi={createFakeOverlayApi} bgmApi={createFakeBgmApi} connectBgm={connectNoBgm} connectPomodoro={connectNoPomodoro} kanjiQuizStop={noKanjiQuizStop} pomodoroApi={createFakePomodoroApi} textApi={createFakeTextApi} recognitionDeps={createRecognitionDeps()} api={createFakeAdminApi(me)} />)

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

describe('WebMCP（エージェント向けのツール）', () => {
  /** 登録されたツールと、その登録を消すための signal */
  interface Registration {
    tool: WebMCP.ModelContextTool
    signal: AbortSignal | undefined
  }

  /**
   * WebMCP に対応したブラウザを装い、document.modelContext に registerTool の代役を置く。
   * rejectName を渡したら、その名前のツールの登録だけを断る
   */
  const installModelContext = (rejectName?: string): Registration[] => {
    const registrations: Registration[] = []
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: {
        registerTool: async (tool: WebMCP.ModelContextTool, options?: WebMCP.ModelContextRegisterToolOptions) => {
          if (tool.name === rejectName) throw new Error('このページではツールを登録できません')
          registrations.push({ tool, signal: options?.signal })
        },
      },
    })
    return registrations
  }

  /** いま有効な（消されていない）登録の中から、名前でツールを探す */
  const activeTool = (registrations: readonly Registration[], name: string): WebMCP.ModelContextTool => {
    const found = registrations.find((registration) => registration.tool.name === name && registration.signal?.aborted !== true)
    if (found === undefined) throw new Error(`${name} は登録されていません`)
    return found.tool
  }

  afterEach(() => {
    Reflect.deleteProperty(document, 'modelContext')
  })

  test('ログインするとツールを登録し、open_page でページを移れる', async () => {
    const registrations = installModelContext()
    renderSignedIn()
    await screen.findByRole('heading', { level: 1, name: 'ダッシュボード' })
    await waitFor(() => expect(() => activeTool(registrations, 'open_page')).not.toThrow())

    const result = await act(() => activeTool(registrations, 'open_page').execute({ path: '/viewers/' }, { signal: new AbortController().signal }))

    expect(result).toBe('「視聴者」のページへ移りました')
    expect(await screen.findByRole('heading', { level: 1, name: '視聴者' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/viewers/')
  })

  test('list_pages はサイドバーと同じページを返す', async () => {
    const registrations = installModelContext()
    renderSignedIn()
    await waitFor(() => expect(() => activeTool(registrations, 'list_pages')).not.toThrow())

    const result = await activeTool(registrations, 'list_pages').execute({}, { signal: new AbortController().signal })

    if (typeof result !== 'string') throw new Error('list_pages の結果が文字列ではありません')
    const listed: { currentPath: string; pages: { group: string; path: string; name: string }[] } = JSON.parse(result)
    expect(listed.currentPath).toBe('/')
    expect(listed.pages).toContainEqual({ group: '配信中', path: '/viewers/', name: '視聴者' })
    expect(listed.pages).toContainEqual({ group: '自動化', path: '/bot/', name: 'チャットボット' })
  })

  test('send_chat_message は、アプリに渡した Api で配信者としてチャットへ送る', async () => {
    const registrations = installModelContext()
    renderSignedIn()
    await waitFor(() => expect(() => activeTool(registrations, 'send_chat_message')).not.toThrow())

    const result = await activeTool(registrations, 'send_chat_message').execute({ sender: 'streamer', message: 'このあと休憩します' }, { signal: new AbortController().signal })

    expect(result).toBe('配信者としてチャットへ送りました')
    expect(createFakeCommentApi.send).toHaveBeenCalledWith('このあと休憩します')
  })

  test('save_settings で開いているページの設定を保存すると、ページを作り直して保存済みの中身を読み直させる', async () => {
    const registrations = installModelContext()
    openPage('/pomodoro/')
    renderSignedIn()
    await screen.findByRole('heading', { level: 1, name: 'ポモドーロ' })
    await waitFor(() => expect(() => activeTool(registrations, 'save_settings')).not.toThrow())
    // 前提: アプリの枠とページが開いたときに読み終えるのを待ってから数える
    await waitFor(() => expect(vi.mocked(createFakePomodoroApi.read).mock.calls.length).toBeGreaterThanOrEqual(2))
    const readsBefore = vi.mocked(createFakePomodoroApi.read).mock.calls.length

    await act(() => activeTool(registrations, 'save_settings').execute({ target: 'pomodoro', value: { breakMediaId: 'media-lofi' } }, { signal: new AbortController().signal }))

    expect(createFakePomodoroApi.saveSettings).toHaveBeenCalledWith({ breakMediaId: 'media-lofi' })
    await waitFor(() => expect(vi.mocked(createFakePomodoroApi.read).mock.calls.length).toBeGreaterThan(readsBefore))
  })

  test('ログアウトすると、登録したツールをすべて消す', async () => {
    const registrations = installModelContext()
    renderSignedIn()
    await waitFor(() => expect(() => activeTool(registrations, 'open_page')).not.toThrow())

    await userEvent.click(screen.getByRole('button', { name: 'ログアウト' }))
    await screen.findByRole('link', { name: 'Twitchでログイン' })

    expect(registrations.length).toBeGreaterThan(0)
    expect(registrations.every((registration) => registration.signal?.aborted === true)).toBe(true)
  })

  test('途中のツールの登録を断られたら、下部バーにエラーを出し、先に登録できたツールも消す', async () => {
    // 前提: list_pages・open_page は登録でき、その次の get_bgm で断られる
    const registrations = installModelContext('get_bgm')
    renderSignedIn()

    const bar = await screen.findByRole('region', { name: '配信中の操作' })
    expect(await within(bar).findByText('WebMCP にツール get_bgm を登録できませんでした: このページではツールを登録できません')).toBeInTheDocument()
    // 一部のツールだけが呼べる状態を残さない
    expect(registrations.map((registration) => registration.tool.name)).toEqual(['list_pages', 'open_page'])
    expect(registrations.every((registration) => registration.signal?.aborted === true)).toBe(true)
  })
})
