/**
 * WebMCP のツール（tools.ts）のテスト
 *
 * ブラウザの document.modelContext は使わず、ツールの定義を作って execute を直接呼ぶ。
 * 下部バーと同じ操作（BGM・ポモドーロ・読み上げのミュート・文字起こし）とページの移動が、
 * アプリの枠の状態を通って実行されることと、受け付けない入力をエラーにすることを確かめる。
 */
import { describe, expect, it } from 'vitest'
import type { BgmPlayback, BgmStep, BgmTrack } from '@/bgm/api'
import type { PomodoroCommand } from '@/pomodoro/api'
import { startTimer, type PomodoroTimer } from '@/pomodoro/phase'
import { buildTools, type WebMcpDeps } from './tools'

/** 試験の時刻（2026-10-07 21:00:00 JST） */
const now = Date.parse('2026-10-07T21:00:00+09:00')
const MINUTE = 60_000

const lofiTrack: BgmTrack = { mediaId: 'media-lofi', title: '夜のローファイ', credit: '作曲: 夜更かし', creditUrl: '', mood: '落ち着いた', scene: '作業中' }
const jazzTrack: BgmTrack = { mediaId: 'media-jazz', title: '雨の日のジャズ', credit: '作曲: 雨音', creditUrl: '', mood: '', scene: '' }

/** 試験用のアプリの枠の状態。操作の呼ばれ方を記録する */
const createDeps = (overrides: Partial<WebMcpDeps> = {}) => {
  const calls = {
    opened: [] as string[],
    savedPlayback: [] as BgmPlayback[],
    skipped: [] as BgmStep[],
    pomodoro: [] as PomodoroCommand[],
    muted: [] as boolean[],
    recognition: [] as boolean[],
  }
  let playback: BgmPlayback = { mediaId: 'media-lofi', volume: 0.4, repeat: false, shuffle: true }
  let timer: PomodoroTimer | null = null
  const deps: WebMcpDeps = {
    pages: [
      { group: '配信中', path: '/', name: 'ダッシュボード' },
      { group: '配信中', path: '/bgm/', name: 'BGM' },
    ],
    currentPath: () => '/',
    openPage: (path) => {
      calls.opened.push(path)
      return 'moved'
    },
    bgm: () => ({
      loaded: { status: 'ready' },
      savedTracks: [lofiTrack, jazzTrack],
      playback,
      savePlayback: async (next) => {
        calls.savedPlayback.push(next)
        playback = next
        return next
      },
      skip: async (step) => {
        calls.skipped.push(step)
        playback = { ...playback, mediaId: 'media-jazz' }
        return playback
      },
    }),
    pomodoro: () => ({
      loaded: { status: 'ready' },
      timer,
      control: async (command) => {
        calls.pomodoro.push(command)
        timer = command === 'start' ? startTimer(now - 3 * MINUTE) : null
        return timer
      },
    }),
    now: () => now,
    speechMute: {
      load: async () => false,
      save: async (muted) => {
        calls.muted.push(muted)
        return muted
      },
    },
    recognition: () => ({
      enabled: true,
      phase: 'running',
      error: null,
      setEnabled: (enabled) => {
        calls.recognition.push(enabled)
      },
    }),
    ...overrides,
  }
  return { deps, calls }
}

const signal = new AbortController().signal

/** 名前でツールを取り出して実行する */
const run = async (deps: WebMcpDeps, name: string, input: Record<string, unknown> = {}): Promise<unknown> => {
  const tool = buildTools(deps).find((candidate) => candidate.name === name)
  if (tool === undefined) throw new Error(`${name} というツールがありません`)
  return tool.execute(input, { signal })
}

/** ツールの返す文字列を JSON として読む */
const runJson = async (deps: WebMcpDeps, name: string, input: Record<string, unknown> = {}): Promise<unknown> => {
  const result = await run(deps, name, input)
  if (typeof result !== 'string') throw new Error('ツールの結果が文字列ではありません')
  return JSON.parse(result)
}

describe('ツールの一覧', () => {
  it('名前が重ならず、どれにも説明と入力の形がある', () => {
    const tools = buildTools(createDeps().deps)
    const names = tools.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    for (const tool of tools) {
      expect(tool.description).not.toBe('')
      expect(tool.inputSchema).toMatchObject({ type: 'object' })
    }
  })

  it('状態を読むだけのツールには readOnlyHint が付いている', () => {
    const tools = buildTools(createDeps().deps)
    const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name)
    expect(readOnly).toEqual(['list_pages', 'get_bgm', 'get_pomodoro', 'get_speech_mute', 'get_transcription'])
  })
})

describe('ページの移動', () => {
  it('ページの一覧と、いま開いているページを返す', async () => {
    const { deps } = createDeps()
    expect(await runJson(deps, 'list_pages')).toEqual({
      currentPath: '/',
      pages: [
        { group: '配信中', path: '/', name: 'ダッシュボード' },
        { group: '配信中', path: '/bgm/', name: 'BGM' },
      ],
    })
  })

  it('一覧にあるページへ移る', async () => {
    const { deps, calls } = createDeps()
    expect(await run(deps, 'open_page', { path: '/bgm/' })).toBe('「BGM」のページへ移りました')
    expect(calls.opened).toEqual(['/bgm/'])
  })

  it('未保存の変更があって確認を出したときは、移っていないことを伝える', async () => {
    const { deps } = createDeps({ openPage: () => 'confirming' })
    expect(await run(deps, 'open_page', { path: '/bgm/' })).toBe(
      '今のページに未保存の変更があるため、移る前に確認を出しました。配信者が「移る」を選ぶまで「BGM」のページへは移りません',
    )
  })

  it('一覧にないパスはエラーにする', async () => {
    const { deps, calls } = createDeps()
    await expect(run(deps, 'open_page', { path: '/overlay/stage/' })).rejects.toThrow('/overlay/stage/ というページはありません')
    expect(calls.opened).toEqual([])
  })
})

describe('BGM', () => {
  it('流している曲・音量・曲の一覧を返す', async () => {
    const { deps } = createDeps()
    expect(await runJson(deps, 'get_bgm')).toEqual({
      nowPlaying: '夜のローファイ',
      volumePercent: 40,
      repeat: false,
      shuffle: true,
      tracks: ['夜のローファイ', '雨の日のジャズ'],
    })
  })

  it('止めているときは nowPlaying を null にする', async () => {
    const { deps } = createDeps()
    const original = deps.bgm
    deps.bgm = () => ({ ...original(), playback: { ...original().playback, mediaId: null } })
    expect(await runJson(deps, 'get_bgm')).toMatchObject({ nowPlaying: null })
  })

  it('読み込めていないときはエラーにする', async () => {
    const { deps } = createDeps()
    const original = deps.bgm
    deps.bgm = () => ({ ...original(), loaded: { status: 'failed', message: 'BGMの設定を読めませんでした' } })
    await expect(run(deps, 'get_bgm')).rejects.toThrow('BGMの設定を読めませんでした')
    deps.bgm = () => ({ ...original(), loaded: { status: 'loading' } })
    await expect(run(deps, 'get_bgm')).rejects.toThrow('BGMの設定をまだ読み込んでいます')
  })

  it('次の曲へ進め、切り替えた曲名を返す', async () => {
    const { deps, calls } = createDeps()
    expect(await run(deps, 'skip_bgm', { step: 'next' })).toBe('「雨の日のジャズ」に切り替えました')
    expect(calls.skipped).toEqual(['next'])
  })

  it('曲が1つもなければ進めずにエラーにする', async () => {
    const { deps, calls } = createDeps()
    const original = deps.bgm
    deps.bgm = () => ({ ...original(), savedTracks: [] })
    await expect(run(deps, 'skip_bgm', { step: 'next' })).rejects.toThrow('BGMの曲が登録されていません')
    expect(calls.skipped).toEqual([])
  })

  it('next・previous 以外の向きはエラーにする', async () => {
    const { deps } = createDeps()
    await expect(run(deps, 'skip_bgm', { step: 'random' })).rejects.toThrow('step は next・previous のどれかにしてください')
  })

  it('止めるときは音量や繰り返しを変えずに曲だけを外す', async () => {
    const { deps, calls } = createDeps()
    expect(await run(deps, 'stop_bgm')).toBe('BGMを止めました')
    expect(calls.savedPlayback).toEqual([{ mediaId: null, volume: 0.4, repeat: false, shuffle: true }])
  })

  it('音量を百分率で変える', async () => {
    const { deps, calls } = createDeps()
    expect(await run(deps, 'set_bgm_volume', { percent: 25 })).toBe('BGMの音量を25%にしました')
    expect(calls.savedPlayback).toEqual([{ mediaId: 'media-lofi', volume: 0.25, repeat: false, shuffle: true }])
  })

  it('0〜100の整数でない音量はエラーにする', async () => {
    const { deps, calls } = createDeps()
    await expect(run(deps, 'set_bgm_volume', { percent: 101 })).rejects.toThrow('percent は 0〜100 の整数にしてください')
    await expect(run(deps, 'set_bgm_volume', { percent: 12.5 })).rejects.toThrow('percent は 0〜100 の整数にしてください')
    await expect(run(deps, 'set_bgm_volume', { percent: '50' })).rejects.toThrow('percent は 0〜100 の整数にしてください')
    expect(calls.savedPlayback).toEqual([])
  })
})

describe('ポモドーロ', () => {
  it('止めているときは stopped を返す', async () => {
    const { deps } = createDeps()
    expect(await runJson(deps, 'get_pomodoro')).toEqual({ state: 'stopped' })
  })

  it('動いているときは区間と残り時間を返す', async () => {
    const { deps } = createDeps()
    const original = deps.pomodoro
    deps.pomodoro = () => ({ ...original(), timer: startTimer(now - 3 * MINUTE) })
    expect(await runJson(deps, 'get_pomodoro')).toEqual({ state: 'running', phase: 'work', round: 1, remaining: '22:00' })
  })

  it('一時停止しているときは paused を返す', async () => {
    const { deps } = createDeps()
    const original = deps.pomodoro
    deps.pomodoro = () => ({ ...original(), timer: { ...startTimer(now - 3 * MINUTE), pausedAt: now - MINUTE } })
    expect(await runJson(deps, 'get_pomodoro')).toEqual({ state: 'paused', phase: 'work', round: 1, remaining: '23:00' })
  })

  it('操作して、操作したあとの状態を返す', async () => {
    const { deps, calls } = createDeps()
    expect(await runJson(deps, 'control_pomodoro', { command: 'start' })).toEqual({ state: 'running', phase: 'work', round: 1, remaining: '22:00' })
    expect(await runJson(deps, 'control_pomodoro', { command: 'stop' })).toEqual({ state: 'stopped' })
    expect(calls.pomodoro).toEqual(['start', 'stop'])
  })

  it('知らない操作はエラーにする', async () => {
    const { deps, calls } = createDeps()
    await expect(run(deps, 'control_pomodoro', { command: 'skip' })).rejects.toThrow('command は start・pause・resume・stop のどれかにしてください')
    expect(calls.pomodoro).toEqual([])
  })

  it('読み込めていないときはエラーにする', async () => {
    const { deps } = createDeps()
    const original = deps.pomodoro
    deps.pomodoro = () => ({ ...original(), loaded: { status: 'failed', message: 'ポモドーロのタイマーを読めませんでした' } })
    await expect(run(deps, 'get_pomodoro')).rejects.toThrow('ポモドーロのタイマーを読めませんでした')
    await expect(run(deps, 'control_pomodoro', { command: 'start' })).rejects.toThrow('ポモドーロのタイマーを読めませんでした')
  })
})

describe('読み上げのミュート', () => {
  it('ミュートしているかを返す', async () => {
    const { deps } = createDeps()
    expect(await runJson(deps, 'get_speech_mute')).toEqual({ muted: false })
  })

  it('ミュートを切り替え、保存されたあとの値を伝える', async () => {
    const { deps, calls } = createDeps()
    expect(await run(deps, 'set_speech_mute', { muted: true })).toBe('チャットの読み上げをミュートしました')
    expect(await run(deps, 'set_speech_mute', { muted: false })).toBe('チャットの読み上げのミュートを解除しました')
    expect(calls.muted).toEqual([true, false])
  })

  it('真偽値でない値はエラーにする', async () => {
    const { deps } = createDeps()
    await expect(run(deps, 'set_speech_mute', { muted: 'true' })).rejects.toThrow('muted は true か false にしてください')
  })
})

describe('文字起こし', () => {
  it('オンかどうかと認識の様子を返す', async () => {
    const { deps } = createDeps()
    expect(await runJson(deps, 'get_transcription')).toEqual({ enabled: true, phase: 'running', error: null })
  })

  it('オン・オフを切り替える', async () => {
    const { deps, calls } = createDeps()
    expect(await run(deps, 'set_transcription', { enabled: false })).toBe('文字起こしをオフにしました')
    expect(await run(deps, 'set_transcription', { enabled: true })).toBe(
      '文字起こしをオンにしました。マイクの許可を求められたときは、配信者が下部バーの文字起こしのボタンを押す必要があります',
    )
    expect(calls.recognition).toEqual([false, true])
  })

  it('真偽値でない値はエラーにする', async () => {
    const { deps } = createDeps()
    await expect(run(deps, 'set_transcription', { enabled: 1 })).rejects.toThrow('enabled は true か false にしてください')
  })
})
