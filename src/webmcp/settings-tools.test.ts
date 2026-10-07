/**
 * WebMCP の設定を読み書きするツール（settings-tools.ts）のテスト
 *
 * Worker の Api とアプリの枠の状態の代役を渡してツールを作り、execute を直接呼ぶ。確かめること:
 * - 設定の種類（target）ごとに、画面と同じ Api（BGM はアプリの枠の状態）を通って読み書きされること
 * - 保存では Worker が返した問題点をそのまま伝えること
 * - 保存する設定のページを開いていて、未保存の変更があれば保存を断ること
 * - そのページを開いていて未保存の変更がなければ、保存したあとページを作り直させること
 */
import { describe, expect, it } from 'vitest'
import type { StoredTrigger } from '@/admin/api'
import type { BgmSettings, BgmTrack } from '@/bgm/api'
import type { BotCommandItem, ModerationSettings } from '@/bot/api'
import { ApiError } from '@/core/api'
import type { LlmSettings } from '@/llm/api'
import type { Overlay } from '@/overlay/layout'
import type { PomodoroSettings } from '@/pomodoro/api'
import type { SpeechSettings } from '@/speech/api'
import type { StreamTitleSettings } from '@/stats/api'
import { buildSettingsTools, type SettingsDeps } from './settings-tools'

const followTrigger: StoredTrigger = { kind: 'follow', actions: [{ type: 'chat', message: '{user} さん、フォローありがとう！' }] }
const discordCommand: BotCommandItem = { name: 'discord', reply: 'Discord はプロフィールのリンクからどうぞ', cooldownSeconds: 30 }
const moderation: ModerationSettings = { enabled: false, exemptBroadcaster: true, exemptVip: true, exemptSubscriber: false, rules: [] }
const speech: SpeechSettings = {
  engine: 'local',
  host: 'localhost',
  port: 50021,
  speaker: 3,
  speed: 1.2,
  volume: 0.8,
  maxLength: 60,
  readName: true,
  ignoreLogins: ['nightbot'],
}
const lightModel = { 'workers-ai': '@cf/meta/llama-3.1-8b-instruct-fp8', openrouter: 'meta-llama/llama-3.1-8b-instruct' }
const llm: LlmSettings = {
  usages: {
    translation: { provider: 'workers-ai', models: lightModel },
    aiChat: { provider: 'openrouter', models: lightModel },
    sideSuper: { provider: 'workers-ai', models: lightModel },
    viewerSummary: { provider: 'workers-ai', models: lightModel },
    streamSummary: { provider: 'workers-ai', models: lightModel },
    streamTitle: { provider: 'workers-ai', models: lightModel },
    townTour: { provider: 'openrouter', models: lightModel },
    townBond: { provider: 'openrouter', models: lightModel },
  },
}
const overlays: Overlay[] = [{ name: '作業配信', items: [] }]
const lofiTrack: BgmTrack = { mediaId: 'media-lofi', title: '夜のローファイ', credit: '作曲: 夜更かし', creditUrl: '', mood: '落ち着いた', scene: '作業中' }
const bgmSettings: BgmSettings = { judgeWithJev: true }
const pomodoro: PomodoroSettings = { breakMediaId: 'media-lofi' }
const streamTitle: StreamTitleSettings = { enabled: false }

/** 試験用の Api とアプリの枠の状態。保存されたものと、ページを作り直させた回数を記録する */
const createDeps = ({ currentPath = '/', unsaved = false }: { currentPath?: string; unsaved?: boolean } = {}) => {
  const saved: { target: string; value: unknown }[] = []
  const calls = { saved, reloads: 0 }
  /** 保存したものを記録し、そのまま返す保存の代役を作る */
  const recordSave =
    <T,>(target: string) =>
    async (value: T): Promise<T> => {
      saved.push({ target, value })
      return value
    }
  const deps: SettingsDeps = {
    apis: {
      api: {
        config: async () => [followTrigger],
        // 前提: Worker はアラートの素材の種類を書き足して返すが、この試験のトリガーはチャットへ送るだけなので、受け取ったものと同じになる
        saveConfig: async (triggers) => {
          saved.push({ target: 'triggers', value: triggers })
          return [followTrigger]
        },
      },
      botApi: {
        commands: async () => [discordCommand],
        saveCommands: async (commands) => recordSave<BotCommandItem[]>('botCommands')([...commands]),
        moderation: async () => moderation,
        saveModeration: recordSave('moderation'),
      },
      speechApi: { load: async () => speech, save: recordSave('speech') },
      llmApi: { load: async () => ({ settings: llm }), save: recordSave('llm') },
      overlayApi: { load: async () => overlays, save: async (next) => recordSave<Overlay[]>('overlays')([...next]) },
      pomodoroApi: { read: async () => ({ timer: null, settings: pomodoro }), saveSettings: recordSave('pomodoro') },
      statsApi: { titleSettings: async () => streamTitle, saveTitleSettings: recordSave('streamTitle') },
    },
    bgm: () => ({
      loaded: { status: 'ready' },
      savedTracks: [lofiTrack],
      settings: bgmSettings,
      saveTracks: async (tracks) => recordSave<readonly BgmTrack[]>('bgmTracks')(tracks),
      saveSettings: recordSave('bgmSettings'),
    }),
    currentPath: () => currentPath,
    hasUnsavedChanges: () => unsaved,
    reloadPage: () => {
      calls.reloads += 1
    },
  }
  return { deps, calls }
}

const signal = new AbortController().signal

/** 名前でツールを取り出して実行する */
const run = async (deps: SettingsDeps, name: string, input: Record<string, unknown>): Promise<unknown> => {
  const tool = buildSettingsTools(deps).find((candidate) => candidate.name === name)
  if (tool === undefined) throw new Error(`${name} というツールがありません`)
  return tool.execute(input, { signal })
}

/** 実行して、返った文字列を JSON として読む */
const runJson = async (deps: SettingsDeps, name: string, input: Record<string, unknown>): Promise<unknown> => {
  const result = await run(deps, name, input)
  if (typeof result !== 'string') throw new Error('ツールの結果が文字列ではありません')
  return JSON.parse(result)
}

/** 設定の種類ごとの、読める中身 */
const SETTINGS: [target: string, value: unknown][] = [
  ['triggers', [followTrigger]],
  ['botCommands', [discordCommand]],
  ['moderation', moderation],
  ['speech', speech],
  ['llm', llm],
  ['overlays', overlays],
  ['bgmTracks', [lofiTrack]],
  ['bgmSettings', bgmSettings],
  ['pomodoro', pomodoro],
  ['streamTitle', streamTitle],
]

describe('ツールの一覧', () => {
  it('読むツールには readOnlyHint、保存するツールには consequentialHint を付ける', () => {
    const tools = buildSettingsTools(createDeps().deps)
    expect(tools.map((tool) => [tool.name, tool.annotations])).toEqual([
      ['get_settings', { readOnlyHint: true }],
      ['save_settings', { consequentialHint: true }],
    ])
  })
})

describe('設定を読む', () => {
  it.each(SETTINGS)('%s の設定をまるごと返す', async (target, value) => {
    const { deps } = createDeps()
    expect(await runJson(deps, 'get_settings', { target })).toEqual(value)
  })

  it('知らない種類はエラーにする', async () => {
    const { deps } = createDeps()
    await expect(run(deps, 'get_settings', { target: 'rewards' })).rejects.toThrow(/^target は triggers・botCommands・/)
  })

  it('BGM の設定をまだ読み込んでいなければエラーにする', async () => {
    const { deps } = createDeps()
    const original = deps.bgm
    deps.bgm = () => ({ ...original(), loaded: { status: 'loading' } })
    await expect(run(deps, 'get_settings', { target: 'bgmTracks' })).rejects.toThrow('BGMの設定をまだ読み込んでいます')
  })
})

describe('設定を保存する', () => {
  it.each(SETTINGS)('%s の設定を Api へ渡し、保存された設定を返す', async (target, value) => {
    const { deps, calls } = createDeps()
    expect(await runJson(deps, 'save_settings', { target, value })).toEqual(value)
    expect(calls.saved).toEqual([{ target, value }])
  })

  it('value が無ければ保存しない', async () => {
    const { deps, calls } = createDeps()
    await expect(run(deps, 'save_settings', { target: 'speech' })).rejects.toThrow('value に保存する設定をまるごと渡してください')
    expect(calls.saved).toEqual([])
  })

  it('Worker が断ったら、問題点をそのまま伝える', async () => {
    const { deps } = createDeps()
    deps.apis.speechApi = {
      ...deps.apis.speechApi,
      save: async () => {
        throw new ApiError(400, 'invalid-config', '読み上げの設定に問題があります', ['speed は 0.5〜2 にしてください', 'port は 1〜65535 にしてください'])
      },
    }
    await expect(run(deps, 'save_settings', { target: 'speech', value: { ...speech, speed: 9 } })).rejects.toThrow(
      '読み上げの設定に問題があります\n- speed は 0.5〜2 にしてください\n- port は 1〜65535 にしてください',
    )
  })
})

describe('開いているページとの食い違い', () => {
  it('その設定のページで未保存の変更を入力中なら、保存を断る', async () => {
    // 前提: 配信者がトリガーのページで入力の途中
    const { deps, calls } = createDeps({ currentPath: '/triggers/', unsaved: true })
    await expect(run(deps, 'save_settings', { target: 'triggers', value: [followTrigger] })).rejects.toThrow(
      '配信者が「トリガー」のページで保存していない変更を入力しているので、保存しませんでした',
    )
    expect(calls.saved).toEqual([])
    expect(calls.reloads).toBe(0)
  })

  it('その設定のページを開いていて未保存の変更がなければ、保存してからページを作り直させる', async () => {
    const { deps, calls } = createDeps({ currentPath: '/triggers/' })
    await run(deps, 'save_settings', { target: 'triggers', value: [followTrigger] })
    expect(calls.saved).toHaveLength(1)
    expect(calls.reloads).toBe(1)
  })

  it('別のページで入力中でも、その設定のページでなければ保存し、ページは作り直させない', async () => {
    // 前提: 配信者はチャットボットのページで入力の途中。保存するのはトリガー
    const { deps, calls } = createDeps({ currentPath: '/bot/', unsaved: true })
    await run(deps, 'save_settings', { target: 'triggers', value: [followTrigger] })
    expect(calls.saved).toHaveLength(1)
    expect(calls.reloads).toBe(0)
  })

  it('保存に失敗したら、ページを作り直させない', async () => {
    const { deps, calls } = createDeps({ currentPath: '/connectors/' })
    deps.apis.speechApi = {
      ...deps.apis.speechApi,
      save: async () => {
        throw new ApiError(400, 'invalid-config', '読み上げの設定に問題があります', [])
      },
    }
    await expect(run(deps, 'save_settings', { target: 'speech', value: speech })).rejects.toThrow('読み上げの設定に問題があります')
    expect(calls.reloads).toBe(0)
  })
})
