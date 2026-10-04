// @vitest-environment jsdom
/**
 * 下部バーのポモドーロのテスト（issue #237）
 *
 * 確かめること:
 * - 止めているときは「始める」だけを出し、押すと Worker に始めてもらって区間と残り時間を出すこと
 * - 動いているときは「一時停止」「止める」、一時停止しているときは「再開」「止める」を出すこと
 * - 区間と残り時間を押すと、ポモドーロのページ（/pomodoro/）へ移れること
 * - 押し出されたタイマー（別の窓での操作・配信していないときの区切りで止めた）をバーに映すこと
 * - 操作が断られたら理由を出して今の状態を読み直すこと、読めない・押し出しを受け取れていないときも理由を出すこと（Fail-Fast）
 * - 断られた理由は、そのあとタイマーが変わったら消すこと（古い理由を出し続けない）
 * - 最初に読めなくても、押し出しが届いたら立ち直ること。押し出しのあとに最初の読み込みが失敗しても「読めない」に戻さないこと
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test } from 'vitest'
import { ApiError } from '@/core/api'
import type { PomodoroApi, PomodoroCommand } from './api'
import type { PomodoroTimer } from './phase'
import { PomodoroBar } from './pomodoro-bar'
import { PomodoroTimerProvider, type PomodoroWatchHandlers } from './timer-context'

afterEach(cleanup)

const MINUTE = 60 * 1000
const startedAt = Date.parse('2026-10-03T12:00:00Z')
/** 始めてから10分たったところ */
const now = startedAt + 10 * MINUTE

/** 10分前に始めて動いているタイマー（作業の残りは15分） */
const runningTimer: PomodoroTimer = { startedAt, anchorAt: startedAt, pausedAt: null }
/** 5分たったところで一時停止したタイマー（作業の残りは20分） */
const pausedTimer: PomodoroTimer = { startedAt, anchorAt: startedAt, pausedAt: startedAt + 5 * MINUTE }

/** 操作を記録し、決めたタイマーを返す代役。readTimer は Worker にある今のタイマーを返す */
const createApi = ({ timer = null as PomodoroTimer | null, failRead = false } = {}) => {
  let shouldFailRead = failRead
  const commands: PomodoroCommand[] = []
  let reads = 0
  const api: PomodoroApi & { current: PomodoroTimer | null; failNext: ApiError | null; reads: () => number; recoverRead: () => void } = {
    current: timer,
    recoverRead: () => {
      shouldFailRead = false
    },
    failNext: null,
    reads: () => reads,
    read: async () => {
      reads += 1
      if (shouldFailRead) throw new Error('Workerにつながりません')
      return { timer: api.current, settings: { breakMediaId: null } }
    },
    saveSettings: async (settings) => settings,
    control: async (command) => {
      commands.push(command)
      if (api.failNext) throw api.failNext
      if (command === 'start') api.current = { startedAt: now, anchorAt: now, pausedAt: null }
      if (command === 'stop') api.current = null
      return api.current
    },
  }
  return { api, commands }
}

/** 押し出しの接続の代役。渡された受け口を覚えておき、テストから押し出しや切断を届ける */
const fakeConnection = () => {
  let handlers: PomodoroWatchHandlers | null = null
  const getHandlers = (): PomodoroWatchHandlers => {
    if (handlers === null) throw new Error('まだ押し出しの接続をつないでいません')
    return handlers
  }
  return {
    connect: (_overlayKey: string, next: PomodoroWatchHandlers) => {
      handlers = next
      return { close: () => undefined }
    },
    push: (timer: PomodoroTimer | null) => act(() => getHandlers().onMessage(JSON.stringify({ timer }))),
    disconnect: () => act(() => getHandlers().onStatus('disconnected')),
    reconnect: () => act(() => getHandlers().onStatus('reconnected')),
  }
}

const renderBar = (api: PomodoroApi, connection = fakeConnection(), overlayKey: string | null = 'overlay-key') =>
  render(
    <PomodoroTimerProvider api={api} overlayKey={overlayKey} connect={connection.connect}>
      <PomodoroBar now={() => now} />
    </PomodoroTimerProvider>,
  )

describe('PomodoroBar', () => {
  test('止めているときは「始める」だけを出し、押すと区間と残り時間を出す', async () => {
    const { api, commands } = createApi()
    renderBar(api)

    await userEvent.click(await screen.findByRole('button', { name: 'ポモドーロを始める' }))

    expect(commands).toEqual(['start'])
    expect(await screen.findByRole('link', { name: 'ポモドーロ: 作業中 1本目 残り25:00' })).toHaveAttribute('href', '/pomodoro/')
    expect(screen.getByRole('button', { name: 'ポモドーロを一時停止' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'ポモドーロを止める' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'ポモドーロを始める' })).not.toBeInTheDocument()
  })

  test('動いているときは、残り時間と「一時停止」「止める」を出す', async () => {
    const { api, commands } = createApi({ timer: runningTimer })
    renderBar(api)

    expect(await screen.findByText('15:00')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'ポモドーロを一時停止' }))

    expect(commands).toEqual(['pause'])
  })

  test('一時停止しているときは「再開」「止める」を出す', async () => {
    const { api, commands } = createApi({ timer: pausedTimer })
    renderBar(api)

    expect(await screen.findByRole('link', { name: 'ポモドーロ: 一時停止中 1本目 残り20:00' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'ポモドーロを再開' }))

    expect(commands).toEqual(['resume'])
  })

  test('配信していないときの区切りで Worker が止めたら、押し出しを受けて「始める」に戻る', async () => {
    const { api } = createApi({ timer: runningTimer })
    const connection = fakeConnection()
    renderBar(api, connection)
    expect(await screen.findByText('15:00')).toBeInTheDocument()

    connection.push(null)

    expect(screen.getByRole('button', { name: 'ポモドーロを始める' })).toBeInTheDocument()
    expect(screen.queryByText('15:00')).not.toBeInTheDocument()
  })

  test('操作が断られたら理由を出し、今の状態を読み直す', async () => {
    // 前提: 別の窓で始めたが、まだ押し出しが届いていない
    const { api } = createApi()
    renderBar(api)
    const startButton = await screen.findByRole('button', { name: 'ポモドーロを始める' })
    api.current = runningTimer
    api.failNext = new ApiError(409, 'pomodoro-running', 'ポモドーロのタイマーはもう動いています', [])

    await userEvent.click(startButton)

    expect(await screen.findByRole('alert')).toHaveTextContent('ポモドーロのタイマーはもう動いています')
    expect(screen.getByRole('button', { name: 'ポモドーロを一時停止' })).toBeInTheDocument()
    expect(api.reads()).toBe(2)
  })

  test('断られた理由は、そのあと別の窓でタイマーが変わったら消す', async () => {
    // 前提: 別の窓で始めていたので「始める」が断られ、読み直して「動いている」になった
    const { api } = createApi()
    const connection = fakeConnection()
    renderBar(api, connection)
    const startButton = await screen.findByRole('button', { name: 'ポモドーロを始める' })
    api.current = runningTimer
    api.failNext = new ApiError(409, 'pomodoro-running', 'ポモドーロのタイマーはもう動いています', [])
    await userEvent.click(startButton)
    expect(await screen.findByRole('alert')).toHaveTextContent('ポモドーロのタイマーはもう動いています')

    // 別の窓で一時停止したことが押し出されてくる
    connection.push(pausedTimer)

    expect(screen.getByRole('button', { name: 'ポモドーロを再開' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('最初に読めなくても、押し出しが届いたら理由を消して操作できるようにする', async () => {
    const { api } = createApi({ failRead: true })
    const connection = fakeConnection()
    renderBar(api, connection)
    expect(await screen.findByRole('alert')).toHaveTextContent('Workerにつながりません')

    connection.push(runningTimer)

    expect(screen.getByText('15:00')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'ポモドーロを一時停止' })).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('押し出しが届いたあとで最初の読み込みが失敗しても、「読めない」に戻さない', async () => {
    // 前提: 最初の読み込みは、押し出しが届いてから失敗する
    const { api } = createApi()
    let rejectRead: (error: Error) => void = () => undefined
    api.read = () =>
      new Promise((_resolve, reject) => {
        rejectRead = reject
      })
    const connection = fakeConnection()
    renderBar(api, connection)
    connection.push(runningTimer)

    await act(async () => rejectRead(new Error('Workerにつながりません')))

    expect(screen.getByText('15:00')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'ポモドーロを一時停止' })).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('読み込めなければ、理由を出す', async () => {
    const { api } = createApi({ failRead: true })
    renderBar(api)

    expect(await screen.findByRole('alert')).toHaveTextContent('Workerにつながりません')
  })

  test('最初に読めなくても、つなぎ直して読めたら理由を消して操作できるようにする', async () => {
    // 前提: 開いたときは Worker に届かなかったが、そのあと届くようになった
    const { api } = createApi({ failRead: true, timer: runningTimer })
    const connection = fakeConnection()
    renderBar(api, connection)
    expect(await screen.findByRole('alert')).toHaveTextContent('Workerにつながりません')
    api.recoverRead()

    await connection.reconnect()

    expect(await screen.findByText('15:00')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'ポモドーロを一時停止' })).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('押し出しが切れたら、受け取れていないことを出す', async () => {
    const { api } = createApi()
    const connection = fakeConnection()
    renderBar(api, connection)
    await screen.findByRole('button', { name: 'ポモドーロを始める' })

    connection.disconnect()

    expect(screen.getByRole('alert')).toHaveTextContent('ポモドーロのタイマーの変化を受け取れていません')
  })

  test('オーバーレイ用キーが無ければ、別の窓での操作を映せないことを出す', async () => {
    const { api } = createApi()
    renderBar(api, fakeConnection(), null)

    expect(await screen.findByRole('alert')).toHaveTextContent('オーバーレイ用キーが未発行')
  })
})
