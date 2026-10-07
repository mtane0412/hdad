/**
 * WebMCP で登録する、設定を読み書きするツール（issue #282 の段階4）
 *
 * トリガー・チャットボットのコマンドとモデレーション・読み上げ・LLM・オーバーレイの構成・BGM の曲と設定・
 * ポモドーロの休憩の曲・配信タイトルの候補の設定を、get_settings と save_settings の2つのツールで読み書きする。
 * どの設定かは target で選ぶ（設定ごとにツールを分けると、エージェントに見せる一覧が20個近く並ぶため）。
 *
 * 読むときは設定をまるごと返し、保存するときも設定をまるごと受け取って Worker へそのまま渡す。値の検証は Worker だけが持つ
 * （.claude/rules/implementation.md）ので、ここでは形を確かめず、Worker が断ったら問題点（ApiError.problems）をそのまま伝える。
 *
 * 開いているページとの食い違いは次のように扱う。
 * - 保存する設定のページで配信者が未保存の変更を入力中なら、保存を断る（入力中の内容を黙って捨てさせないため）
 * - そのページを開いていて未保存の変更がなければ、保存したあとページを作り直し、保存済みの中身を読み直させる
 *   （古い中身を出し続けると、配信者が次に保存したときにツールの保存を上書きするため）
 *
 * 注意: BGM の曲と設定はアプリの枠の BgmPlayerProvider を通して読み書きする（下部バーにも映すため。段階1と同じ）。
 * 注意: 確かめてから保存し終えるまでのあいだに配信者が入力を始めると、作り直しで入力が消える。ツールの保存は
 *   一瞬で終わるので、この隙間は残している。
 */
import type { WebMCP } from 'webmcp-types'
import type { AdminApi } from '@/admin/api'
import type { BgmPlayerValue } from '@/bgm/player-context'
import type { BotApi } from '@/bot/api'
import { ApiError } from '@/core/api'
import type { LlmApi, LlmState } from '@/llm/api'
import type { OverlayLayoutAdminApi } from '@/overlay/admin-api'
import type { PomodoroApi } from '@/pomodoro/api'
import type { SpeechApi } from '@/speech/api'
import type { StatsApi } from '@/stats/api'
import { readChoice } from './input'

/** 設定を読み書きするツールが使う Worker の Api（名前はアプリの枠の PageContext と同じ） */
export interface SettingsApis {
  api: Pick<AdminApi, 'config' | 'saveConfig'>
  botApi: Pick<BotApi, 'commands' | 'saveCommands' | 'moderation' | 'saveModeration'>
  speechApi: SpeechApi
  /** load は設定（settings）を読むためだけに使う */
  llmApi: Pick<LlmApi, 'save'> & { load(): Promise<Pick<LlmState, 'settings'>> }
  overlayApi: OverlayLayoutAdminApi
  pomodoroApi: Pick<PomodoroApi, 'read' | 'saveSettings'>
  statsApi: Pick<StatsApi, 'titleSettings' | 'saveTitleSettings'>
}

/** 設定を読み書きするツールが使う、Worker の Api とアプリの枠の状態 */
export interface SettingsDeps {
  apis: SettingsApis
  bgm(): Pick<BgmPlayerValue, 'loaded' | 'savedTracks' | 'settings' | 'saveTracks' | 'saveSettings'>
  /** いま開いているページのパス（末尾は必ずスラッシュ） */
  currentPath(): string
  /** いま開いているページに未保存の変更があるか */
  hasUnsavedChanges(): boolean
  /** いま開いているページを作り直し、保存済みの中身を読み直させる */
  reloadPage(): void
}

/** 読み書きできる設定の種類 */
const SETTING_TARGETS = ['triggers', 'botCommands', 'moderation', 'speech', 'llm', 'overlays', 'bgmTracks', 'bgmSettings', 'pomodoro', 'streamTitle'] as const
type SettingTarget = (typeof SETTING_TARGETS)[number]

/** 設定1種類ぶんの読み書き */
interface Setting {
  /** 配信者に見せる名前（断ったときの文面に使う） */
  label: string
  /** この設定を編集するページのパス */
  pagePath: string
  load(): Promise<unknown>
  save(value: unknown): Promise<unknown>
}

/**
 * エージェントが渡した設定を、Api が受け取る型として Worker へ送る。
 *
 * 形の検証は Worker だけが持つ（.claude/rules/implementation.md）ので、ここでは確かめずに型だけを合わせる。
 * 形が違えば Worker が問題点を挙げて断り、その問題点がそのままエージェントに返る。
 */
const asSubmitted = <T>(value: unknown): T => value as T

/** 読み込みが終わった BGM の状態を取る（読み込み中の既定値を、保存済みの設定として返さないため） */
const loadedBgm = (deps: SettingsDeps) => {
  const bgm = deps.bgm()
  if (bgm.loaded.status === 'loading') throw new Error('BGMの設定をまだ読み込んでいます。少し待ってからやり直してください')
  if (bgm.loaded.status === 'failed') throw new Error(bgm.loaded.message)
  return bgm
}

/** 設定の種類ごとの読み書き */
const buildSettings = (deps: SettingsDeps): Record<SettingTarget, Setting> => {
  const { api, botApi, speechApi, llmApi, overlayApi, pomodoroApi, statsApi } = deps.apis
  return {
    triggers: { label: 'トリガー', pagePath: '/triggers/', load: () => api.config(), save: (value) => api.saveConfig(asSubmitted(value)) },
    botCommands: { label: 'チャットボット', pagePath: '/bot/', load: () => botApi.commands(), save: (value) => botApi.saveCommands(asSubmitted(value)) },
    moderation: { label: 'チャットボット', pagePath: '/bot/', load: () => botApi.moderation(), save: (value) => botApi.saveModeration(asSubmitted(value)) },
    speech: { label: 'コネクター', pagePath: '/connectors/', load: () => speechApi.load(), save: (value) => speechApi.save(asSubmitted(value)) },
    llm: { label: 'LLM', pagePath: '/llm/', load: async () => (await llmApi.load()).settings, save: (value) => llmApi.save(asSubmitted(value)) },
    overlays: { label: 'オーバーレイ', pagePath: '/overlay/', load: () => overlayApi.load(), save: (value) => overlayApi.save(asSubmitted(value)) },
    bgmTracks: {
      label: 'BGM',
      pagePath: '/bgm/',
      load: async () => loadedBgm(deps).savedTracks,
      save: (value) => loadedBgm(deps).saveTracks(asSubmitted(value)),
    },
    bgmSettings: {
      label: 'BGM',
      pagePath: '/bgm/',
      load: async () => loadedBgm(deps).settings,
      save: (value) => loadedBgm(deps).saveSettings(asSubmitted(value)),
    },
    pomodoro: {
      label: 'ポモドーロ',
      pagePath: '/pomodoro/',
      load: async () => (await pomodoroApi.read()).settings,
      save: (value) => pomodoroApi.saveSettings(asSubmitted(value)),
    },
    streamTitle: {
      label: 'ダッシュボード',
      pagePath: '/',
      load: () => statsApi.titleSettings(),
      save: (value) => statsApi.saveTitleSettings(asSubmitted(value)),
    },
  }
}

/**
 * 設定を保存する。Worker が問題点を挙げて断ったら、問題点を1行ずつ文面に足して投げ直す（エージェントが直してやり直せるように）
 */
const saveWithProblems = async (setting: Setting, value: unknown): Promise<unknown> => {
  try {
    return await setting.save(value)
  } catch (error) {
    if (!(error instanceof ApiError) || error.problems.length === 0) throw error
    throw new Error([error.message, ...error.problems.map((problem) => `- ${problem}`)].join('\n'), { cause: error })
  }
}

/** target の入力の形（読む・保存するの両方で使う） */
const TARGET_SCHEMA = {
  type: 'string',
  enum: SETTING_TARGETS,
  description:
    'triggers（トリガー）・botCommands（チャットボットのコマンド）・moderation（モデレーション）・speech（チャットの読み上げ）・llm（LLMのモデル）・overlays（オーバーレイの構成）・bgmTracks（BGMの曲）・bgmSettings（BGMの設定）・pomodoro（ポモドーロの休憩の曲）・streamTitle（配信タイトルの候補を作るか）',
} as const

/**
 * 設定を読み書きするツールを作る。
 *
 * @param deps Worker の Api とアプリの枠の状態（webmcp-tools.tsx が渡す）
 */
export const buildSettingsTools = (deps: SettingsDeps): WebMCP.ModelContextTool[] => {
  const settings = buildSettings(deps)
  return [
    {
      name: 'get_settings',
      title: '設定を読む',
      description: 'HDAD の設定を1種類、保存されている中身のまま JSON で返します。変えるときは、この中身を書き換えて save_settings にまるごと渡します。',
      inputSchema: { type: 'object', properties: { target: TARGET_SCHEMA }, required: ['target'] },
      annotations: { readOnlyHint: true },
      execute: async (input) => JSON.stringify(await settings[readChoice(input, 'target', SETTING_TARGETS)].load()),
    },
    {
      name: 'save_settings',
      title: '設定を保存する',
      description:
        'HDAD の設定を1種類、まるごと置き換えて保存し、保存された設定を JSON で返します。value には get_settings が返した形の中身を、変えない部分も含めてまるごと渡します。値に問題があれば、問題点を挙げたエラーになります。配信者がその設定のページで保存していない変更を入力しているあいだは保存しません。',
      inputSchema: {
        type: 'object',
        properties: { target: TARGET_SCHEMA, value: { description: '保存する設定（get_settings が返した形のまるごと）' } },
        required: ['target', 'value'],
      },
      annotations: { consequentialHint: true },
      execute: async (input) => {
        const setting = settings[readChoice(input, 'target', SETTING_TARGETS)]
        if (input.value === undefined) throw new Error('value に保存する設定をまるごと渡してください')
        const pageOpen = deps.currentPath() === setting.pagePath
        if (pageOpen && deps.hasUnsavedChanges()) {
          throw new Error(
            `配信者が「${setting.label}」のページで保存していない変更を入力しているので、保存しませんでした。配信者に保存するか取り消すかを決めてもらってから、やり直してください`,
          )
        }
        const saved = await saveWithProblems(setting, input.value)
        // 開いているページに古い中身を出し続けさせない
        if (pageOpen) deps.reloadPage()
        return JSON.stringify(saved)
      },
    },
  ]
}
