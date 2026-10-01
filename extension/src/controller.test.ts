/**
 * 拡張のボタンが押されたときの手順と、ボタンの表示のテスト
 *
 * Chrome の API は偽物に差し替え、次を確かめる。
 * - 映していないときに押されたら、そのタブのIDを取って取り込ませ、映しているタブとして覚える
 * - 映しているタブでもう一度押されたら止める
 * - 別のタブで押されたら、そのタブに切り替える
 * - IDを取れない・取り込めないときは、黙らずにボタンで知らせる
 * - 取り込んだタブが閉じられたら（offscreen document からの知らせ）、止めて何も映していない表示に戻す
 * - ボタンの表示（バッジと説明）が状態ごとに分かれる
 */
import { describe, expect, it } from 'vitest'
import { createSerialQueue, describeBadge, handleClick, handleOffscreenEvent, type BadgeState, type ControllerApi } from './controller'

const slideTab = { id: 7 }
const videoTab = { id: 9 }

const createApi = (options: { capturing?: number; failStreamId?: string; failCapture?: string; failStop?: string } = {}) => {
  let capturing: number | null = options.capturing ?? null
  const calls: string[] = []
  const shown: BadgeState[] = []
  const api: ControllerApi = {
    capturingTabId: async () => capturing,
    remember: async (tabId) => {
      capturing = tabId
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

    expect(calls).toEqual(['IDを取る:7', '取り込む:ストリームID-7'])
    expect(capturing()).toBe(7)
    expect(shown.at(-1)).toEqual({ kind: 'capturing', viewers: 0, warning: null })
  })

  it('映しているタブでもう一度押されたら止める', async () => {
    const { api, calls, shown, capturing } = createApi({ capturing: 7 })

    await handleClick(slideTab, api)

    expect(calls).toEqual(['止める'])
    expect(capturing()).toBeNull()
    expect(shown.at(-1)).toEqual({ kind: 'idle' })
  })

  it('別のタブで押されたら、そのタブに切り替える', async () => {
    const { api, calls, capturing } = createApi({ capturing: 7 })

    await handleClick(videoTab, api)

    expect(calls).toEqual(['IDを取る:9', '取り込む:ストリームID-9'])
    expect(capturing()).toBe(9)
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

    expect(calls).toEqual(['IDを取る:7'])
    expect(capturing()).toBeNull()
    expect(shown.at(-1)).toEqual({ kind: 'problem', message: 'このタブは映せません: Chrome pages cannot be captured.' })
  })

  it('映していないときに取り込めなければ、用意した取り込み先を片付けて知らせる', async () => {
    const { api, calls, shown, capturing } = createApi({ failCapture: 'Error starting tab capture' })

    await handleClick(slideTab, api)

    expect(calls).toEqual(['IDを取る:7', '取り込む:ストリームID-7', '止める'])
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
    const { api, capturing } = createApi({ capturing: 7, failStop: 'Could not establish connection' })

    await expect(handleClick(slideTab, api)).rejects.toThrow('Could not establish connection')
    expect(capturing()).toBeNull()
  })

  it('切り替えで取り込めなければ、前のタブを映したまま知らせる', async () => {
    const { api, calls, shown, capturing } = createApi({ capturing: 7, failCapture: 'Error starting tab capture' })

    await handleClick(videoTab, api)

    expect(calls).toEqual(['IDを取る:9', '取り込む:ストリームID-9'])
    expect(capturing()).toBe(7)
    expect(shown.at(-1)).toEqual({ kind: 'problem', message: 'タブを取り込めませんでした: Error starting tab capture。もう一度押してください' })
  })
})

describe('handleOffscreenEvent', () => {
  it('取り込みの状態が届いたら、映している表示にする', async () => {
    const { api, shown } = createApi({ capturing: 7 })

    await handleOffscreenEvent({ type: 'state', viewers: 2, warning: null }, api)

    expect(shown).toEqual([{ kind: 'capturing', viewers: 2, warning: null }])
  })

  it('映していないときに遅れて届いた状態は、表示に出さない', async () => {
    // 止めた直後に、止める前の状態が届くことがある
    const { api, shown } = createApi()

    await handleOffscreenEvent({ type: 'state', viewers: 1, warning: null }, api)

    expect(shown).toEqual([])
  })

  it('取り込んだタブが閉じられたら、止めて何も映していない表示に戻す', async () => {
    const { api, calls, shown, capturing } = createApi({ capturing: 7 })

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
