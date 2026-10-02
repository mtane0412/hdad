/**
 * 拡張のボタンが押されたときの手順と、ボタンの表示のテスト
 *
 * Chrome の API は偽物に差し替え、次を確かめる。
 * - 映していないときに押されたら、そのタブのIDを取って取り込ませ、映しているタブとして覚える
 * - 映しているタブでもう一度押されたら止める
 * - 別のタブで押されたら、そのタブに切り替える
 * - IDを取れない・取り込めないときは、黙らずにボタンで知らせる
 * - 取り込んだタブが閉じられたら（offscreen document からの知らせ）、止めて何も映していない表示に戻す
 * - 映さないサイトの一覧を読めない・押したタブが映さないサイトなら、映し始めない
 * - 映しているタブが映さないサイトへ移ったら送るのを止め、映してよいページが表示されたら送り直す
 * - ボタンの右クリックで、そのタブのサイトを映さないサイトに登録し、登録済みなら映すサイトに戻す（項目の名前も切り替える）
 * - 設定ページからの頼み（一覧・追加・削除）に応じ、映しているタブにもすぐ反映する
 * - ボタンの右クリックで、映しているタブに範囲を選ぶ画面を出し、選ばれた範囲を送る。範囲を外してタブ全体に戻す（issue #166）
 * - ボタンの表示（バッジと説明）が状態ごとに分かれる
 * - chrome.storage.session から読み戻した記録が、覚えたときの形か確かめられる
 */
import { describe, expect, it } from 'vitest'
import {
  createSerialQueue,
  describeBadge,
  describeSiteMenu,
  handleAreaPicked,
  handleClearAreaClick,
  handleClick,
  handleNavigation,
  handlePickAreaClick,
  handleOffscreenEvent,
  handleSettingsRequest,
  handleSiteMenuClick,
  isCaptureState,
  refreshSiteMenu,
  type BadgeState,
  type CaptureState,
  type ClickedTab,
  type ControllerApi,
  type SiteMenuView,
} from './controller'

const slideTab = { id: 7, url: 'https://docs.google.com/presentation/d/配信のスライド' }
const videoTab = { id: 9, url: 'https://www.youtube.com/watch?v=紹介する動画' }
const mailUrl = 'https://mail.google.com/mail/u/0/#inbox'
const mailTab = { id: 11, url: mailUrl }
/** 配信者が登録した映さないサイト */
const blockedHosts = ['mail.google.com']

/** スライドのタブを映しているときの記録 */
const capturingSlide = (overrides: Partial<CaptureState> = {}): CaptureState => ({
  tabId: slideTab.id,
  url: slideTab.url,
  pausedAt: null,
  ...overrides,
})

const createApi = (
  options: {
    capturing?: CaptureState
    failStreamId?: string
    failCapture?: string
    failStop?: string
    failPause?: string
    failResume?: string
    failLoadHosts?: string
    failAddHost?: string
    failRemoveHost?: string
    failPickArea?: string
    failSetCrop?: string
    /** 拡張が覚えている一覧（null は覚えていない。既定は Worker と同じ一覧） */
    known?: string[] | null
    /** いま前に出ているタブ（右クリックの項目の名前を決める） */
    activeTab?: ClickedTab | null
  } = {},
) => {
  let capturing: CaptureState | null = options.capturing ?? null
  let storedHosts = [...blockedHosts]
  let known: readonly string[] | null = options.known === undefined ? [...blockedHosts] : options.known
  const calls: string[] = []
  const shown: BadgeState[] = []
  const menus: SiteMenuView[] = []
  const api: ControllerApi = {
    capturing: async () => capturing,
    remember: async (state) => {
      capturing = state
    },
    knownBlockedHosts: async () => known,
    rememberBlockedHosts: async (hosts) => {
      known = hosts
    },
    activeTab: async () => (options.activeTab === undefined ? slideTab : options.activeTab),
    loadBlockedHosts: async () => {
      calls.push('一覧を読む')
      if (options.failLoadHosts !== undefined) throw new Error(options.failLoadHosts)
      return storedHosts
    },
    addBlockedHost: async (host) => {
      calls.push(`登録する:${host}`)
      if (options.failAddHost !== undefined) throw new Error(options.failAddHost)
      storedHosts = [...storedHosts, host]
      return storedHosts
    },
    removeBlockedHost: async (host) => {
      calls.push(`外す:${host}`)
      if (options.failRemoveHost !== undefined) throw new Error(options.failRemoveHost)
      storedHosts = storedHosts.filter((entry) => entry !== host)
      return storedHosts
    },
    getMediaStreamId: async (targetTabId) => {
      calls.push(`IDを取る:${targetTabId}`)
      if (options.failStreamId !== undefined) throw new Error(options.failStreamId)
      return `ストリームID-${targetTabId}`
    },
    startCapture: async (streamId) => {
      calls.push(`取り込む:${streamId}`)
      if (options.failCapture !== undefined) throw new Error(options.failCapture)
    },
    stopCapture: async () => {
      calls.push('止める')
      if (options.failStop !== undefined) throw new Error(options.failStop)
    },
    pauseCapture: async () => {
      calls.push('送るのを止める')
      if (options.failPause !== undefined) throw new Error(options.failPause)
    },
    resumeCapture: async () => {
      calls.push('送り直す')
      if (options.failResume !== undefined) throw new Error(options.failResume)
    },
    pickArea: async (tabId) => {
      calls.push(`範囲を選ぶ画面を出す:${tabId}`)
      if (options.failPickArea !== undefined) throw new Error(options.failPickArea)
    },
    setCrop: async (crop) => {
      calls.push(`範囲を送る:${JSON.stringify(crop)}`)
      if (options.failSetCrop !== undefined) throw new Error(options.failSetCrop)
    },
    show: async (state) => {
      shown.push(state)
    },
    showSiteMenu: async (menu) => {
      menus.push(menu)
    },
  }
  return { api, calls, shown, menus, capturing: () => capturing, known: () => known }
}

describe('handleClick', () => {
  it('映していないときに押されたら、そのタブを取り込ませて覚える', async () => {
    const { api, calls, shown, capturing } = createApi()

    await handleClick(slideTab, api)

    expect(calls).toEqual(['一覧を読む', 'IDを取る:7', '取り込む:ストリームID-7'])
    expect(capturing()).toEqual(capturingSlide())
    expect(shown.at(-1)).toEqual({ kind: 'capturing', viewers: 0, warning: null })
  })

  it('映しているタブでもう一度押されたら止める', async () => {
    const { api, calls, shown, capturing } = createApi({ capturing: capturingSlide() })

    await handleClick(slideTab, api)

    expect(calls).toEqual(['止める'])
    expect(capturing()).toBeNull()
    expect(shown.at(-1)).toEqual({ kind: 'idle' })
  })

  it('別のタブで押されたら、そのタブに切り替える', async () => {
    const { api, calls, capturing } = createApi({ capturing: capturingSlide() })

    await handleClick(videoTab, api)

    expect(calls).toEqual(['一覧を読む', 'IDを取る:9', '取り込む:ストリームID-9'])
    expect(capturing()?.tabId).toBe(9)
  })

  it('映すタブを特定できなければ、何もせずに知らせる', async () => {
    const { api, calls, shown } = createApi()

    await handleClick({}, api)

    expect(calls).toEqual([])
    expect(shown.at(-1)).toEqual({ kind: 'problem', message: '映すタブを特定できませんでした。映したいタブを開いてから押してください' })
  })

  it('IDを取れないタブ（chrome:// のページなど）は、取り込ませずに知らせる', async () => {
    const { api, calls, shown, capturing } = createApi({ failStreamId: 'Chrome pages cannot be captured.' })

    await handleClick(slideTab, api)

    expect(calls).toEqual(['一覧を読む', 'IDを取る:7'])
    expect(capturing()).toBeNull()
    expect(shown.at(-1)).toEqual({ kind: 'problem', message: 'このタブは映せません: Chrome pages cannot be captured.' })
  })

  it('映していないときに取り込めなければ、用意した取り込み先を片付けて知らせる', async () => {
    const { api, calls, shown, capturing } = createApi({ failCapture: 'Error starting tab capture' })

    await handleClick(slideTab, api)

    expect(calls).toEqual(['一覧を読む', 'IDを取る:7', '取り込む:ストリームID-7', '止める'])
    expect(capturing()).toBeNull()
    expect(shown.at(-1)).toEqual({ kind: 'problem', message: 'タブを取り込めませんでした: Error starting tab capture。もう一度押してください' })
  })

  it('取り込めなかったあとの片付けにも失敗したら、取り込めなかった理由のほうを知らせる', async () => {
    // offscreen document が応えないときは、取り込みも片付けも同じ理由で失敗しうる
    const { api, shown } = createApi({ failCapture: 'Could not establish connection', failStop: 'Could not establish connection' })

    await handleClick(slideTab, api)

    expect(shown.at(-1)).toEqual({ kind: 'problem', message: 'タブを取り込めませんでした: Could not establish connection。もう一度押してください' })
  })

  it('止めるのに失敗しても、映しているタブの記録は消す', async () => {
    // 記録が残ると、次に押したときも止めようとし続け、映し始められなくなる
    const { api, capturing } = createApi({ capturing: capturingSlide(), failStop: 'Could not establish connection' })

    await expect(handleClick(slideTab, api)).rejects.toThrow('Could not establish connection')
    expect(capturing()).toBeNull()
  })

  it('切り替えで取り込めなければ、前のタブを映したまま知らせる', async () => {
    const { api, calls, shown, capturing } = createApi({ capturing: capturingSlide(), failCapture: 'Error starting tab capture' })

    await handleClick(videoTab, api)

    expect(calls).toEqual(['一覧を読む', 'IDを取る:9', '取り込む:ストリームID-9'])
    expect(capturing()?.tabId).toBe(7)
    expect(shown.at(-1)).toEqual({ kind: 'problem', message: 'タブを取り込めませんでした: Error starting tab capture。もう一度押してください' })
  })
})

describe('handleClick と映さないサイト', () => {
  it('映さないサイトの一覧を読めなければ、映し始めずに理由を知らせる', async () => {
    // 保険が読めないまま映し続けるのは危険なので、安全側に倒して映さない
    const { api, calls, shown, capturing } = createApi({ failLoadHosts: 'ログインが必要です' })

    await handleClick(slideTab, api)

    expect(calls).toEqual(['一覧を読む'])
    expect(capturing()).toBeNull()
    expect(shown.at(-1)).toEqual({ kind: 'problem', message: '映さないサイトの一覧を読めないので映しません: ログインが必要です' })
  })

  it('押したタブが映さないサイトなら、映し始めずに知らせる', async () => {
    const { api, calls, shown, capturing } = createApi()

    await handleClick(mailTab, api)

    expect(calls).toEqual(['一覧を読む'])
    expect(capturing()).toBeNull()
    expect(shown.at(-1)).toEqual({
      kind: 'problem',
      message: 'mail.google.com は映さないサイトに登録されているので映しません（ボタンの右クリックか拡張の設定で外せます）',
    })
  })

  it('押したタブのURLが分からなければ、映し始めずに知らせる', async () => {
    const { api, calls, shown } = createApi()

    await handleClick({ id: 7 }, api)

    expect(calls).toEqual([])
    expect(shown.at(-1)).toEqual({ kind: 'problem', message: 'このタブのURLを読めないので映しません。映したいタブを開いてから押してください' })
  })
})

describe('handleNavigation', () => {
  it('映しているタブが映さないサイトへ移り始めたら、送るのを止めて知らせる', async () => {
    const { api, calls, shown, capturing } = createApi({ capturing: capturingSlide() })

    await handleNavigation({ tabId: slideTab.id, url: mailUrl, committed: false }, api)

    expect(calls).toEqual(['送るのを止める'])
    expect(capturing()).toEqual(capturingSlide({ url: mailUrl, pausedAt: 'mail.google.com' }))
    expect(shown.at(-1)).toEqual({ kind: 'paused', host: 'mail.google.com' })
  })

  it('止めているあいだに映さないサイトの中を移っても、止め直さない', async () => {
    const { api, calls } = createApi({ capturing: capturingSlide({ url: mailUrl, pausedAt: 'mail.google.com' }) })

    await handleNavigation({ tabId: slideTab.id, url: 'https://mail.google.com/mail/u/0/#sent', committed: true }, api)

    expect(calls).toEqual([])
  })

  it('止めているあいだに映してよいページへ移り始めただけでは、まだ送り直さない（前のページが映っているため）', async () => {
    const { api, calls, capturing } = createApi({ capturing: capturingSlide({ url: mailUrl, pausedAt: 'mail.google.com' }) })

    await handleNavigation({ tabId: slideTab.id, url: slideTab.url, committed: false }, api)

    expect(calls).toEqual([])
    expect(capturing()?.pausedAt).toBe('mail.google.com')
  })

  it('止めているあいだに映してよいページが表示されたら、送り直す', async () => {
    const { api, calls, shown, capturing } = createApi({ capturing: capturingSlide({ url: mailUrl, pausedAt: 'mail.google.com' }) })

    await handleNavigation({ tabId: slideTab.id, url: slideTab.url, committed: true }, api)

    expect(calls).toEqual(['送り直す'])
    expect(capturing()).toEqual(capturingSlide())
    expect(shown.at(-1)).toEqual({ kind: 'capturing', viewers: 0, warning: null })
  })

  it('送り直せなければ、止めている記録を残す（次に映してよいページが表示されたときにまた送り直す）', async () => {
    const pausedOnMail = capturingSlide({ url: mailUrl, pausedAt: 'mail.google.com' })
    const { api, capturing } = createApi({ capturing: pausedOnMail, failResume: 'Could not establish connection' })

    await expect(handleNavigation({ tabId: slideTab.id, url: slideTab.url, committed: true }, api)).rejects.toThrow('Could not establish connection')
    expect(capturing()).toEqual(pausedOnMail)
  })

  it('映してよいページの中を移ったら、URLを覚えるだけにする', async () => {
    const { api, calls, shown, capturing } = createApi({ capturing: capturingSlide() })
    const nextSlide = 'https://docs.google.com/presentation/d/配信のスライド#slide=2'

    await handleNavigation({ tabId: slideTab.id, url: nextSlide, committed: true }, api)

    expect(calls).toEqual([])
    expect(shown).toEqual([])
    expect(capturing()?.url).toBe(nextSlide)
  })

  it('映さないサイトの一覧を覚えていなければ、映し続けずに止める', async () => {
    // 映しているあいだは一覧を覚えているはずだが、失っていたら照合できないので安全側に倒す
    const { api, calls, shown, capturing } = createApi({ capturing: capturingSlide(), known: null })

    await handleNavigation({ tabId: slideTab.id, url: videoTab.url, committed: true }, api)

    expect(calls).toEqual(['止める'])
    expect(capturing()).toBeNull()
    expect(shown.at(-1)).toEqual({ kind: 'problem', message: '映さないサイトの一覧が分からなくなったので映すのをやめました。もう一度押してください' })
  })

  it('映していないタブが移っても何もしない', async () => {
    const { api, calls, capturing } = createApi({ capturing: capturingSlide() })

    await handleNavigation({ tabId: videoTab.id, url: mailUrl, committed: true }, api)

    expect(calls).toEqual([])
    expect(capturing()).toEqual(capturingSlide())
  })

  it('送るのを止められなければ、映し続けずに取り込みごと止める', async () => {
    const { api, calls, shown, capturing } = createApi({ capturing: capturingSlide(), failPause: 'Could not establish connection' })

    await handleNavigation({ tabId: slideTab.id, url: mailUrl, committed: false }, api)

    expect(calls).toEqual(['送るのを止める', '止める'])
    expect(capturing()).toBeNull()
    expect(shown.at(-1)).toEqual({
      kind: 'problem',
      message: '映さないサイト（mail.google.com）へ移りましたが、送るのを止められなかったので映すのをやめました: Could not establish connection',
    })
  })
})

describe('handleSiteMenuClick', () => {
  it('登録していないサイトで押したら、映さないサイトに登録したことを知らせ、項目を「映す」に切り替える', async () => {
    const { api, calls, shown, menus, known } = createApi({ activeTab: videoTab })

    await handleSiteMenuClick(videoTab, api)

    expect(calls).toEqual(['登録する:www.youtube.com'])
    expect(known()).toEqual([...blockedHosts, 'www.youtube.com'])
    expect(shown.at(-1)).toEqual({ kind: 'registered', host: 'www.youtube.com' })
    expect(menus.at(-1)).toEqual({ title: 'このサイト（www.youtube.com）を映す', enabled: true })
  })

  it('登録済みのサイトで押したら、映すサイトに戻したことを知らせ、項目を「映さない」に切り替える', async () => {
    const { api, calls, shown, menus, known } = createApi({ activeTab: mailTab })

    await handleSiteMenuClick(mailTab, api)

    expect(calls).toEqual(['外す:mail.google.com'])
    expect(known()).toEqual([])
    expect(shown.at(-1)).toEqual({ kind: 'unregistered', host: 'mail.google.com' })
    expect(menus.at(-1)).toEqual({ title: 'このサイト（mail.google.com）を映さない', enabled: true })
  })

  it('映しているタブのサイトを登録したら、すぐに送るのを止める', async () => {
    const { api, calls, shown, capturing } = createApi({ capturing: capturingSlide() })

    await handleSiteMenuClick(slideTab, api)

    expect(calls).toEqual(['登録する:docs.google.com', '送るのを止める'])
    expect(capturing()).toEqual(capturingSlide({ pausedAt: 'docs.google.com' }))
    expect(shown.at(-1)).toEqual({ kind: 'paused', host: 'docs.google.com' })
  })

  it('止めているサイトを映すサイトに戻したら、すぐに送り直す', async () => {
    const { api, calls, shown, capturing } = createApi({ capturing: capturingSlide({ url: mailUrl, pausedAt: 'mail.google.com' }) })

    await handleSiteMenuClick(mailTab, api)

    expect(calls).toEqual(['外す:mail.google.com', '送り直す'])
    expect(capturing()).toEqual(capturingSlide({ url: mailUrl }))
    expect(shown.at(-1)).toEqual({ kind: 'capturing', viewers: 0, warning: null })
  })

  it('映しているタブと関係ないサイトを登録したら、ボタンの表示（映している状態）は変えない', async () => {
    const { api, shown, capturing } = createApi({ capturing: capturingSlide() })

    await handleSiteMenuClick(videoTab, api)

    expect(capturing()).toEqual(capturingSlide())
    expect(shown).toEqual([])
  })

  it('一覧を覚えていなければ、読んでから切り替える', async () => {
    const { api, calls } = createApi({ known: null })

    await handleSiteMenuClick(mailTab, api)

    expect(calls).toEqual(['一覧を読む', '外す:mail.google.com'])
  })

  it('ホスト名で登録できないページ（chrome:// など）では、何もせずに知らせる', async () => {
    const { api, calls, shown } = createApi()

    await handleSiteMenuClick({ id: 3, url: 'chrome://settings/' }, api)

    expect(calls).toEqual([])
    expect(shown.at(-1)).toEqual({ kind: 'problem', message: 'このページはホスト名で登録できません（登録できるのは http・https のページだけです）' })
  })

  it('登録できなければ理由を知らせる', async () => {
    const { api, shown } = createApi({ failAddHost: 'ログインが必要です' })

    await handleSiteMenuClick(videoTab, api)

    expect(shown.at(-1)).toEqual({ kind: 'problem', message: '映さないサイトに登録できませんでした: ログインが必要です' })
  })

  it('映すサイトに戻せなければ理由を知らせる', async () => {
    const { api, shown } = createApi({ failRemoveHost: 'ログインが必要です' })

    await handleSiteMenuClick(mailTab, api)

    expect(shown.at(-1)).toEqual({ kind: 'problem', message: '映すサイトに戻せませんでした: ログインが必要です' })
  })
})

describe('describeSiteMenu', () => {
  it('登録していないサイトでは「映さない」、登録済みのサイトでは「映す」にする', () => {
    expect(describeSiteMenu(videoTab.url, blockedHosts)).toEqual({ title: 'このサイト（www.youtube.com）を映さない', enabled: true })
    expect(describeSiteMenu(mailUrl, blockedHosts)).toEqual({ title: 'このサイト（mail.google.com）を映す', enabled: true })
  })

  it('一覧を覚えていなければ、押すと切り替わることだけを出す', () => {
    expect(describeSiteMenu(mailUrl, null)).toEqual({ title: 'このサイト（mail.google.com）を映さない・映すを切り替える', enabled: true })
  })

  it('ホスト名で登録できないページでは押せなくする', () => {
    expect(describeSiteMenu('chrome://settings/', blockedHosts)).toEqual({ title: 'このページは映さないサイトに登録できません', enabled: false })
    expect(describeSiteMenu(undefined, blockedHosts)).toEqual({ title: 'このページは映さないサイトに登録できません', enabled: false })
  })
})

describe('refreshSiteMenu', () => {
  it('いま前に出ているタブと覚えている一覧から、項目の名前を決める', async () => {
    const { api, menus } = createApi({ activeTab: mailTab })

    await refreshSiteMenu(api)

    expect(menus).toEqual([{ title: 'このサイト（mail.google.com）を映す', enabled: true }])
  })

  it('前に出ているタブが無ければ押せなくする', async () => {
    const { api, menus } = createApi({ activeTab: null })

    await refreshSiteMenu(api)

    expect(menus).toEqual([{ title: 'このページは映さないサイトに登録できません', enabled: false }])
  })
})

describe('handleSettingsRequest', () => {
  it('一覧を頼まれたら、Worker から読み直して返し、覚え直す', async () => {
    const { api, known } = createApi({ known: null })

    expect(await handleSettingsRequest({ type: 'list' }, api)).toEqual({ ok: true, hosts: blockedHosts })
    expect(known()).toEqual(blockedHosts)
  })

  it('手で入力したホスト名を登録し、登録したあとの一覧を返す', async () => {
    const { api, calls } = createApi()

    expect(await handleSettingsRequest({ type: 'add', host: 'bank.example.jp' }, api)).toEqual({ ok: true, hosts: [...blockedHosts, 'bank.example.jp'] })
    expect(calls).toEqual(['登録する:bank.example.jp'])
  })

  it('消したサイトで止めていたら、すぐに送り直す', async () => {
    const { api, calls } = createApi({ capturing: capturingSlide({ url: mailUrl, pausedAt: 'mail.google.com' }) })

    expect(await handleSettingsRequest({ type: 'remove', host: 'mail.google.com' }, api)).toEqual({ ok: true, hosts: [] })
    expect(calls).toEqual(['外す:mail.google.com', '送り直す'])
  })

  it('失敗したら理由を返す（Worker が形の違うホスト名を拒んだときなど）', async () => {
    const { api } = createApi({ failAddHost: '映さないサイトに問題があります: host: ホスト名（例: mail.google.com）だけを指定してください' })

    expect(await handleSettingsRequest({ type: 'add', host: 'https://bank.example.jp/' }, api)).toEqual({
      ok: false,
      message: '映さないサイトに問題があります: host: ホスト名（例: mail.google.com）だけを指定してください',
    })
  })
})

describe('handleOffscreenEvent', () => {
  it('取り込みの状態が届いたら、映している表示にする', async () => {
    const { api, shown } = createApi({ capturing: capturingSlide() })

    await handleOffscreenEvent({ type: 'state', viewers: 2, warning: null }, api)

    expect(shown).toEqual([{ kind: 'capturing', viewers: 2, warning: null }])
  })

  it('映していないときに遅れて届いた状態は、表示に出さない', async () => {
    // 止めた直後に、止める前の状態が届くことがある
    const { api, shown } = createApi()

    await handleOffscreenEvent({ type: 'state', viewers: 1, warning: null }, api)

    expect(shown).toEqual([])
  })

  it('映さないサイトで送るのを止めているあいだは、届いた状態より止めていることを表示する', async () => {
    const { api, shown } = createApi({ capturing: capturingSlide({ url: mailUrl, pausedAt: 'mail.google.com' }) })

    await handleOffscreenEvent({ type: 'state', viewers: 0, warning: null }, api)

    expect(shown).toEqual([{ kind: 'paused', host: 'mail.google.com' }])
  })

  it('取り込んだタブが閉じられたら、止めて何も映していない表示に戻す', async () => {
    const { api, calls, shown, capturing } = createApi({ capturing: capturingSlide() })

    await handleOffscreenEvent({ type: 'ended' }, api)

    expect(calls).toEqual(['止める'])
    expect(capturing()).toBeNull()
    expect(shown).toEqual([{ kind: 'idle' }])
  })
})

describe('handlePickAreaClick', () => {
  it('映しているタブで選ばれたら、そのタブに範囲を選ぶ画面を出す', async () => {
    const { api, calls } = createApi({ capturing: capturingSlide() })

    await handlePickAreaClick(slideTab, api)

    expect(calls).toEqual(['範囲を選ぶ画面を出す:7'])
  })

  it('映していなければ、画面を出さずに知らせる', async () => {
    const { api, calls, shown } = createApi()

    await handlePickAreaClick(slideTab, api)

    expect(calls).toEqual([])
    expect(shown.at(-1)).toEqual({ kind: 'problem', message: 'タブを映していません。映したいタブでボタンを押してから、範囲を選んでください' })
  })

  it('映していない別のタブで選ばれたら、画面を出さずに知らせる', async () => {
    const { api, calls, shown } = createApi({ capturing: capturingSlide() })

    await handlePickAreaClick(videoTab, api)

    expect(calls).toEqual([])
    expect(shown.at(-1)).toEqual({ kind: 'problem', message: '映す範囲は、映しているタブを開いて選んでください' })
  })

  it('画面を出せないページ（chrome:// のページなど）なら知らせる', async () => {
    const { api, shown } = createApi({ capturing: capturingSlide(), failPickArea: 'Cannot access a chrome:// URL' })

    await handlePickAreaClick(slideTab, api)

    expect(shown.at(-1)).toEqual({ kind: 'problem', message: 'このページでは範囲を選べません: Cannot access a chrome:// URL' })
  })
})

describe('handleAreaPicked', () => {
  const rightHalf = { x: 0.5, y: 0, width: 0.5, height: 1 }

  it('映しているタブで選ばれた範囲を送る', async () => {
    const { api, calls } = createApi({ capturing: capturingSlide() })

    await handleAreaPicked({ tabId: slideTab.id, crop: rightHalf }, api)

    expect(calls).toEqual([`範囲を送る:${JSON.stringify(rightHalf)}`])
  })

  it('選んでいるあいだに映すタブが変わっていたら、範囲を送らずに知らせる', async () => {
    const { api, calls, shown } = createApi({ capturing: capturingSlide({ tabId: videoTab.id, url: videoTab.url }) })

    await handleAreaPicked({ tabId: slideTab.id, crop: rightHalf }, api)

    expect(calls).toEqual([])
    expect(shown.at(-1)).toEqual({ kind: 'problem', message: '範囲を選んでいるあいだに映すタブが変わったので、選んだ範囲は使いませんでした' })
  })

  it('範囲を送れなければ知らせる', async () => {
    const { api, shown } = createApi({ capturing: capturingSlide(), failSetCrop: 'タブを映していません' })

    await handleAreaPicked({ tabId: slideTab.id, crop: rightHalf }, api)

    expect(shown.at(-1)).toEqual({ kind: 'problem', message: '映す範囲を変えられませんでした: タブを映していません' })
  })
})

describe('handleClearAreaClick', () => {
  it('映していれば、範囲を外してタブ全体に戻す', async () => {
    const { api, calls } = createApi({ capturing: capturingSlide() })

    await handleClearAreaClick(api)

    expect(calls).toEqual(['範囲を送る:null'])
  })

  it('映していなければ知らせる', async () => {
    const { api, calls, shown } = createApi()

    await handleClearAreaClick(api)

    expect(calls).toEqual([])
    expect(shown.at(-1)).toEqual({ kind: 'problem', message: 'タブを映していないので、外す範囲はありません' })
  })
})

describe('isCaptureState', () => {
  it('映し始めたときに覚えた記録を、読み戻したときに受け入れる', async () => {
    // 覚える形と読み戻すときの確認が食い違うと、映し始めたあとの操作（止める・範囲を選ぶ）がすべて失敗する
    const { api, capturing } = createApi()
    await handleClick(slideTab, api)

    expect(isCaptureState(structuredClone(capturing()))).toBe(true)
  })

  it('映さないサイトで送るのを止めているときの記録も受け入れる', () => {
    expect(isCaptureState(capturingSlide({ pausedAt: 'mail.google.com' }))).toBe(true)
  })

  it('形の違う記録（前の版が覚えたものなど）は受け入れない', () => {
    expect(isCaptureState({ tabId: '7', url: slideTab.url, pausedAt: null })).toBe(false)
    expect(isCaptureState({ tabId: 7, url: slideTab.url })).toBe(false)
    expect(isCaptureState(null)).toBe(false)
  })
})

describe('describeBadge', () => {
  it('映していないときは、バッジを出さない', () => {
    expect(describeBadge({ kind: 'idle' })).toEqual({ text: '', color: null, title: 'このタブを配信に映す（HDAD）' })
  })

  it('映しているときは、つながっている合成ページの数と止め方を説明に出す', () => {
    expect(describeBadge({ kind: 'capturing', viewers: 1, warning: null })).toEqual({
      text: 'ON',
      color: '#188038',
      title: '映しています（合成ページ 1 か所）。映しているタブでもう一度押すと止めます',
    })
  })

  it('映しているが合成ページとつながっていないときは、そのことを説明に出す', () => {
    expect(describeBadge({ kind: 'capturing', viewers: 0, warning: null }).title).toBe(
      '映しています（合成ページとまだつながっていません。OBSに合成ページを読み込み、素材「タブの映像」を置いてください）。映しているタブでもう一度押すと止めます',
    )
  })

  it('映しているが失敗の知らせがあるときは、バッジを「!」にして理由を説明に出す', () => {
    expect(describeBadge({ kind: 'capturing', viewers: 0, warning: '中継先との接続が切れました。つなぎ直しています…' })).toEqual({
      text: '!',
      color: '#d93025',
      title: '中継先との接続が切れました。つなぎ直しています…（映しているタブでもう一度押すと止めます）',
    })
  })

  it('映さないサイトで送るのを止めているときは、バッジを「止」にしてサイトと再開の条件を説明に出す', () => {
    expect(describeBadge({ kind: 'paused', host: 'mail.google.com' })).toEqual({
      text: '止',
      color: '#e37400',
      title: '映さないサイト（mail.google.com）なので、合成ページへ送るのを止めています。映してよいページへ移ると再開します',
    })
  })

  it('映すサイトに戻したら、バッジは出さずに説明で知らせる', () => {
    expect(describeBadge({ kind: 'unregistered', host: 'mail.google.com' })).toEqual({
      text: '',
      color: null,
      title: 'mail.google.com を映さないサイトから外しました',
    })
  })

  it('映さないサイトに登録したら、バッジは出さずに説明で知らせる', () => {
    expect(describeBadge({ kind: 'registered', host: 'mail.google.com' })).toEqual({
      text: '',
      color: null,
      title: 'mail.google.com を映さないサイトに登録しました（もう一度右クリックすると外せます。一覧は拡張の設定で見られます）',
    })
  })

  it('うまくいかなかったときは、バッジを「!」にして理由を説明に出す', () => {
    expect(describeBadge({ kind: 'problem', message: 'このタブは映せません' })).toEqual({ text: '!', color: '#d93025', title: 'このタブは映せません' })
  })
})

describe('createSerialQueue', () => {
  it('前の処理が終わってから次の処理を始める', async () => {
    // ショートカットを素早く2回押したとき、1回目が映しているタブを覚える前に2回目が始まらないようにする
    const enqueue = createSerialQueue((error) => {
      throw error
    })
    const steps: string[] = []
    let finishFirst = (): void => undefined

    enqueue(
      () =>
        new Promise<void>((resolve) => {
          steps.push('1回目を始める')
          finishFirst = () => {
            steps.push('1回目を終える')
            resolve()
          }
        }),
    )
    const second = enqueue(async () => {
      steps.push('2回目を始める')
    })
    await Promise.resolve()
    expect(steps).toEqual(['1回目を始める'])

    finishFirst()
    await second
    expect(steps).toEqual(['1回目を始める', '1回目を終える', '2回目を始める'])
  })

  it('前の処理が失敗しても、失敗を知らせたうえで次の処理を続ける', async () => {
    const failures: unknown[] = []
    const enqueue = createSerialQueue((error) => failures.push(error))
    const steps: string[] = []

    enqueue(async () => {
      throw new Error('1回目の失敗')
    })
    await enqueue(async () => {
      steps.push('2回目')
    })

    expect(failures).toEqual([new Error('1回目の失敗')])
    expect(steps).toEqual(['2回目'])
  })
})
