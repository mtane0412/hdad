// @vitest-environment jsdom
/**
 * ポモドーロのページ（/pomodoro/）のテスト
 *
 * 確かめること:
 * - 止めているときは「始める」だけを出し、押すと Worker に始めてもらって残り時間を出すこと
 * - 動いているときは「一時停止」「止める」、一時停止しているときは「再開」「止める」を出すこと
 * - 休憩の曲は BGM の一覧から選び、選んだらすぐ保存すること（「曲を変えない」も選べる）
 * - 読み込めなかったとき・操作が断られたときは、黙らずに理由を出すこと（断られたら今の状態を読み直す）
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test } from 'vitest'
import type { BgmApi, BgmTrack } from '@/bgm/api'
import { ApiError } from '@/core/api'
import type { PomodoroApi, PomodoroCommand, PomodoroSettings } from './api'
import type { PomodoroTimer } from './phase'
import { PomodoroPage } from './pomodoro-page'

afterEach(cleanup)

const MINUTE = 60 * 1000
const startedAt = Date.parse('2026-10-03T12:00:00Z')
/** 始めてから10分たったところ */
const now = startedAt + 10 * MINUTE

const track = (mediaId: string, title: string): BgmTrack => ({ mediaId, title, credit: 'フリーBGM配布所', creditUrl: '', mood: '', scene: '' })
const workTrack = track('media-作業用ピアノ', '作業用ピアノ')
const breakTrack = track('media-休憩のカフェ', '休憩のカフェ')

/** BGMの一覧だけを返す BGM の読み出しの代役（このページは曲の一覧しか使わない） */
const bgmApi = {
  load: async () => ({ tracks: [workTrack, breakTrack], playback: { mediaId: null, volume: 0.3, repeat: false, shuffle: false }, settings: { judgeWithJev: false } }),
} as unknown as BgmApi

/** 操作と保存を記録し、決めたタイマーを返す代役 */
const createApi = ({ timer = null as PomodoroTimer | null, settings = { breakMediaId: null } as PomodoroSettings, failRead = false } = {}) => {
  const commands: PomodoroCommand[] = []
  const savedSettings: PomodoroSettings[] = []
  let current = timer
  const api: PomodoroApi & { failNext: ApiError | null } = {
    failNext: null,
    read: async () => {
      if (failRead) throw new Error('Workerにつながりません')
      return { timer: current, settings }
    },
    saveSettings: async (next) => {
      savedSettings.push(next)
      return next
    },
    control: async (command) => {
      commands.push(command)
      if (api.failNext) throw api.failNext
      if (command === 'start') current = { startedAt: now, anchorAt: now, pausedAt: null }
      if (command === 'stop') current = null
      return current
    },
  }
  return { api, commands, savedSettings }
}

const renderPage = (api: PomodoroApi) => render(<PomodoroPage api={api} bgmApi={bgmApi} now={() => now} />)

describe('PomodoroPage', () => {
  test('止めているときは「始める」だけを出し、押すと残り時間を出す', async () => {
    const { api, commands } = createApi()
    renderPage(api)

    await userEvent.click(await screen.findByRole('button', { name: '始める' }))

    expect(commands).toEqual(['start'])
    expect(await screen.findByText('25:00')).toBeInTheDocument()
    expect(screen.getByText('作業中')).toBeInTheDocument()
    expect(screen.getByText('1本目')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '一時停止' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '始める' })).not.toBeInTheDocument()
  })

  test('動いているときは、いまの区間と残り時間・「一時停止」「止める」を出す', async () => {
    const { api } = createApi({ timer: { startedAt, anchorAt: startedAt, pausedAt: null } })
    renderPage(api)

    expect(await screen.findByText('15:00')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '一時停止' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '止める' })).toBeInTheDocument()
  })

  test('一時停止しているときは「再開」を出し、押すと再開してもらう', async () => {
    const { api, commands } = createApi({ timer: { startedAt, anchorAt: startedAt, pausedAt: startedAt + 5 * MINUTE } })
    renderPage(api)

    expect(await screen.findByText('一時停止中')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '再開' }))

    expect(commands).toEqual(['resume'])
  })

  test('休憩の曲を BGM の一覧から選ぶと、すぐ保存する', async () => {
    const { api, savedSettings } = createApi()
    renderPage(api)

    const select = await screen.findByRole('combobox', { name: '休憩中に流す曲' })
    expect(select).toHaveValue('')
    await userEvent.selectOptions(select, '休憩のカフェ')

    await waitFor(() => expect(savedSettings).toEqual([{ breakMediaId: breakTrack.mediaId }]))
  })

  test('「曲を変えない」を選ぶと、休憩の曲を外して保存する', async () => {
    const { api, savedSettings } = createApi({ settings: { breakMediaId: breakTrack.mediaId } })
    renderPage(api)

    const select = await screen.findByRole('combobox', { name: '休憩中に流す曲' })
    expect(select).toHaveValue(breakTrack.mediaId)
    await userEvent.selectOptions(select, '曲を変えない')

    await waitFor(() => expect(savedSettings).toEqual([{ breakMediaId: null }]))
  })

  test('読み込めなければ、理由を出す', async () => {
    const { api } = createApi({ failRead: true })
    renderPage(api)

    expect(await screen.findByText('Workerにつながりません')).toBeInTheDocument()
  })

  test('操作が断られたら、理由を出す', async () => {
    const { api } = createApi()
    api.failNext = new ApiError(409, 'pomodoro-running', 'ポモドーロのタイマーはもう動いています', [])
    renderPage(api)

    await userEvent.click(await screen.findByRole('button', { name: '始める' }))

    expect(await screen.findByText('ポモドーロのタイマーはもう動いています')).toBeInTheDocument()
  })
})
