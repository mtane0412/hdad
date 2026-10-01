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
 * - ボタンの右クリックで、そのタブのホスト名を映さないサイトに登録する
 * - ボタンの表示（バッジと説明）が状態ごとに分かれる
 */
import { describe, expect, it } from 'vitest'
import {
  createSerialQueue,
  describeBadge,
  handleBlockSite,
  handleClick,
  handleNavigation,
  handleOffscreenEvent,
  type BadgeState,
  type CaptureState,
  type ControllerApi,
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
  blockedHosts,
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
  } = {},
) => {
  let capturing: CaptureState | null = options.capturing ?? null
  let storedHosts = [...blockedHosts]
  const calls: string[] = []
  const shown: BadgeState[] = []
  const api: ControllerApi = {
    capturing: async () => capturing,
    remember: async (state) => {
      capturing = state
    },
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
    show: async (state) => {
      shown.push(state)
    },
  }
  return { api, calls, shown, capturing: () => capturing }
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
      message: 'mail.google.com は映さないサイトに登録されているので映しません（一覧は HDAD の「タブの映像」のページで消せます）',
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

describe('handleBlockSite', () => {
  it('右クリックしたタブのホスト名を登録し、登録したことを知らせる', async () => {
    const { api, calls, shown } = createApi()

    await handleBlockSite(videoTab, api)

    expect(calls).toEqual(['登録する:www.youtube.com'])
    expect(shown.at(-1)).toEqual({ kind: 'registered', host: 'www.youtube.com' })
  })

  it('映しているタブのサイトを登録したら、すぐに送るのを止める', async () => {
    const { api, calls, shown, capturing } = createApi({ capturing: capturingSlide() })

    await handleBlockSite(slideTab, api)

    expect(calls).toEqual(['登録する:docs.google.com', '送るのを止める'])
    expect(capturing()).toEqual(capturingSlide({ blockedHosts: [...blockedHosts, 'docs.google.com'], pausedAt: 'docs.google.com' }))
    expect(shown.at(-1)).toEqual({ kind: 'paused', host: 'docs.google.com' })
  })

  it('映しているタブと関係ないサイトを登録したら、一覧だけ覚え直して表示は変えない', async () => {
    const { api, shown, capturing } = createApi({ capturing: capturingSlide() })

    await handleBlockSite(videoTab, api)

    expect(capturing()?.blockedHosts).toEqual([...blockedHosts, 'www.youtube.com'])
    expect(capturing()?.pausedAt).toBeNull()
    expect(shown).toEqual([])
  })

  it('ホスト名で登録できないページ（chrome:// など）では、登録せずに知らせる', async () => {
    const { api, calls, shown } = createApi()

    await handleBlockSite({ id: 3, url: 'chrome://settings/' }, api)

    expect(calls).toEqual([])
    expect(shown.at(-1)).toEqual({ kind: 'problem', message: 'このページはホスト名で登録できません（登録できるのは http・https のページだけです）' })
  })

  it('登録できなければ理由を知らせる', async () => {
    const { api, shown } = createApi({ failAddHost: 'ログインが必要です' })

    await handleBlockSite(videoTab, api)

    expect(shown.at(-1)).toEqual({ kind: 'problem', message: '映さないサイトに登録できませんでした: ログインが必要です' })
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

  it('映さないサイトに登録したら、バッジは出さずに説明で知らせる', () => {
    expect(describeBadge({ kind: 'registered', host: 'mail.google.com' })).toEqual({
      text: '',
      color: null,
      title: 'mail.google.com を映さないサイトに登録しました（一覧は HDAD の「タブの映像」のページで消せます）',
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
