/**
 * WebMCP で登録するツールの定義（issue #279 の段階1: 配信中の操作とページの移動）
 *
 * 段階2（配信に出る操作。broadcast-tools.ts）・段階3（記録の読み取り。record-tools.ts）以降のツールは話題ごとのファイルに分け、buildTools がまとめて返す。
 *
 * ブラウザのエージェントが HDAD を操作できるよう、下部バーでできること（BGM・ポモドーロ・読み上げのミュート・
 * 文字起こし）とページの移動をツールにする。ツールは画面のボタンと同じくアプリの枠の状態（BgmPlayerProvider など）を
 * 通して操作するので、エージェントが操作した結果は下部バーやページにもそのまま映る。
 *
 * 通信も DOM も持たず、アプリの枠の状態は deps で受け取る（テストで差し替えるため。登録は register.ts、
 * 状態の受け渡しは webmcp-tools.tsx が受け持つ）。
 *
 * 注意: 入力の形は inputSchema で示すが、ブラウザがそれで検証してくれるとは限らないので execute でも確かめ、
 * 受け付けない値はエラーにする（Fail-Fast。既定値に丸めて実行しない）。
 * 注意: 結果は文字列で返す（WebMCP の仕様）。状態を返すツールは JSON の文字列にする。
 */
import type { WebMCP } from 'webmcp-types'
import type { BgmStep, BgmTrack } from '@/bgm/api'
import { volumeOfPercent, volumePercentOf } from '@/bgm/form'
import type { BgmPlayerValue } from '@/bgm/player-context'
import type { PomodoroCommand } from '@/pomodoro/api'
import { formatRemaining, phaseAt, type PomodoroTimer } from '@/pomodoro/phase'
import type { PomodoroTimerValue } from '@/pomodoro/timer-context'
import type { SpeechMuteApi } from '@/speech/api'
import type { RecognitionContextValue } from '@/transcript/recognition-context'
import { buildBroadcastTools, type BroadcastApis } from './broadcast-tools'
import { NO_INPUT, readBoolean, readChoice } from './input'
import { buildRecordTools, type RecordApis } from './record-tools'

/** ページの一覧の1項目（サイドバーの項目と同じ） */
export interface PageEntry {
  /** サイドバーのまとまりの名前 */
  group: string
  /** パス（末尾は必ずスラッシュ） */
  path: string
  name: string
}

/** ページの移動の結果。未保存の変更があるページからは、配信者の確認を待つ（'confirming'） */
export type OpenPageResult = 'moved' | 'confirming'

/** ツールが使う、アプリの枠の状態と操作。状態は変わり続けるので、呼ぶたびに最新を返す関数で受け取る */
export interface WebMcpDeps {
  pages: readonly PageEntry[]
  currentPath(): string
  openPage(path: string): OpenPageResult
  bgm(): Pick<BgmPlayerValue, 'loaded' | 'savedTracks' | 'playback' | 'savePlayback' | 'skip'>
  pomodoro(): Pick<PomodoroTimerValue, 'loaded' | 'timer' | 'control'>
  now(): number
  speechMute: SpeechMuteApi
  recognition(): Pick<RecognitionContextValue, 'enabled' | 'phase' | 'error' | 'setEnabled'>
  /** Worker の Api（段階2以降のツールが使う。名前はアプリの枠の PageContext と同じ） */
  apis: WebMcpApis
}

/** 段階2以降のツールが使う Worker の Api。アプリの枠の PageContext をそのまま渡せる形にする */
export type WebMcpApis = BroadcastApis & RecordApis

const BGM_STEPS: readonly BgmStep[] = ['next', 'previous']
const POMODORO_COMMANDS: readonly PomodoroCommand[] = ['start', 'pause', 'resume', 'stop']
/** 音量の上限（百分率） */
const MAX_VOLUME_PERCENT = 100

/** 読み込みが終わっていなければ投げる（読み込み中の既定値を、いまの状態として返さないため） */
const ensureLoaded = (loaded: BgmPlayerValue['loaded'] | PomodoroTimerValue['loaded'], loadingMessage: string): void => {
  if (loaded.status === 'loading') throw new Error(loadingMessage)
  if (loaded.status === 'failed') throw new Error(loaded.message)
}

/** 曲の素材のIDから曲名を引く。一覧に無ければ（別の窓で消した直後など）IDをそのまま出す */
const trackTitle = (tracks: readonly BgmTrack[], mediaId: string): string => tracks.find((track) => track.mediaId === mediaId)?.title ?? mediaId

/** 読み込みが終わった BGM の状態を取る */
const loadedBgm = (deps: WebMcpDeps) => {
  const bgm = deps.bgm()
  ensureLoaded(bgm.loaded, 'BGMの設定をまだ読み込んでいます。少し待ってからやり直してください')
  return bgm
}

/** 読み込みが終わったポモドーロの状態を取る */
const loadedPomodoro = (deps: WebMcpDeps) => {
  const pomodoro = deps.pomodoro()
  ensureLoaded(pomodoro.loaded, 'ポモドーロのタイマーをまだ読み込んでいます。少し待ってからやり直してください')
  return pomodoro
}

/** ポモドーロのタイマーを、エージェントに返す形にする */
const describeTimer = (timer: PomodoroTimer | null, now: number) => {
  if (timer === null) return { state: 'stopped' }
  const phase = phaseAt(timer, now)
  return {
    state: timer.pausedAt === null ? 'running' : 'paused',
    phase: phase.kind,
    round: phase.round,
    remaining: formatRemaining(phase.remainingMs),
  }
}

/**
 * 登録するツールを作る。
 *
 * @param deps アプリの枠の状態と操作（webmcp-tools.tsx が最新の値を渡す）
 */
export const buildTools = (deps: WebMcpDeps): WebMCP.ModelContextTool[] => [
  {
    name: 'list_pages',
    title: 'ページの一覧',
    description: 'HDAD の管理画面のページの一覧（パスと名前）と、いま開いているページのパスを返します。',
    inputSchema: NO_INPUT,
    annotations: { readOnlyHint: true },
    execute: () => JSON.stringify({ currentPath: deps.currentPath(), pages: deps.pages }),
  },
  {
    name: 'open_page',
    title: 'ページを開く',
    description: 'HDAD の管理画面のページへ移ります。path には list_pages が返したパスを指定します。今のページに未保存の変更があれば、配信者の確認を待ちます。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '移る先のパス（例: /bgm/）' } },
      required: ['path'],
    },
    execute: (input) => {
      const page = deps.pages.find((candidate) => candidate.path === input.path)
      if (page === undefined) throw new Error(`${String(input.path)} というページはありません。list_pages が返したパスを指定してください`)
      if (deps.openPage(page.path) === 'moved') return `「${page.name}」のページへ移りました`
      return `今のページに未保存の変更があるため、移る前に確認を出しました。配信者が「移る」を選ぶまで「${page.name}」のページへは移りません`
    },
  },
  {
    name: 'get_bgm',
    title: 'BGMの状態',
    description: '配信のBGMで流している曲（止めていれば null）・音量（百分率）・繰り返し・シャッフルと、登録されている曲名の一覧を返します。',
    inputSchema: NO_INPUT,
    annotations: { readOnlyHint: true },
    execute: () => {
      const bgm = loadedBgm(deps)
      const { mediaId, volume, repeat, shuffle } = bgm.playback
      return JSON.stringify({
        nowPlaying: mediaId === null ? null : trackTitle(bgm.savedTracks, mediaId),
        volumePercent: volumePercentOf(volume),
        repeat,
        shuffle,
        tracks: bgm.savedTracks.map((track) => track.title),
      })
    },
  },
  {
    name: 'skip_bgm',
    title: 'BGMの曲を進める',
    description: '配信のBGMを次の曲（next）か前の曲（previous）へ切り替えます。止めているときに next を指定すると再生を始めます。',
    inputSchema: {
      type: 'object',
      properties: { step: { type: 'string', enum: BGM_STEPS, description: 'next（次の曲）か previous（前の曲）' } },
      required: ['step'],
    },
    execute: async (input) => {
      const step = readChoice(input, 'step', BGM_STEPS)
      const bgm = loadedBgm(deps)
      if (bgm.savedTracks.length === 0) throw new Error('BGMの曲が登録されていません。BGMのページで曲を登録してください')
      const next = await bgm.skip(step)
      if (next.mediaId === null) return 'BGMは止まっています'
      return `「${trackTitle(bgm.savedTracks, next.mediaId)}」に切り替えました`
    },
  },
  {
    name: 'stop_bgm',
    title: 'BGMを止める',
    description: '配信のBGMを止めます。音量や繰り返しの設定はそのまま残ります。',
    inputSchema: NO_INPUT,
    execute: async () => {
      const bgm = loadedBgm(deps)
      await bgm.savePlayback({ ...bgm.playback, mediaId: null })
      return 'BGMを止めました'
    },
  },
  {
    name: 'set_bgm_volume',
    title: 'BGMの音量を変える',
    description: '配信のBGMの音量を百分率（0〜100の整数）で変えます。',
    inputSchema: {
      type: 'object',
      properties: { percent: { type: 'integer', minimum: 0, maximum: MAX_VOLUME_PERCENT, description: '音量（百分率）' } },
      required: ['percent'],
    },
    execute: async (input) => {
      const percent = input.percent
      if (typeof percent !== 'number' || !Number.isInteger(percent) || percent < 0 || percent > MAX_VOLUME_PERCENT) {
        throw new Error(`percent は 0〜${MAX_VOLUME_PERCENT} の整数にしてください`)
      }
      const bgm = loadedBgm(deps)
      await bgm.savePlayback({ ...bgm.playback, volume: volumeOfPercent(percent) })
      return `BGMの音量を${percent}%にしました`
    },
  },
  {
    name: 'get_pomodoro',
    title: 'ポモドーロの状態',
    description:
      'ポモドーロのタイマー（作業25分・休憩5分）の状態を返します。state は running・paused・stopped のどれかで、動いていれば phase（work か break）・round（何本目か）・remaining（区間の残り。分:秒）も返します。',
    inputSchema: NO_INPUT,
    annotations: { readOnlyHint: true },
    execute: () => JSON.stringify(describeTimer(loadedPomodoro(deps).timer, deps.now())),
  },
  {
    name: 'control_pomodoro',
    title: 'ポモドーロを操作する',
    description: 'ポモドーロのタイマーを操作し、操作したあとの状態を get_pomodoro と同じ形で返します。command は start（開始）・pause（一時停止）・resume（再開）・stop（停止）のどれかです。',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', enum: POMODORO_COMMANDS } },
      required: ['command'],
    },
    execute: async (input) => {
      const command = readChoice(input, 'command', POMODORO_COMMANDS)
      const timer = await loadedPomodoro(deps).control(command)
      return JSON.stringify(describeTimer(timer, deps.now()))
    },
  },
  {
    name: 'get_speech_mute',
    title: '読み上げのミュートの状態',
    description: 'チャットの読み上げをミュートしているかを返します。',
    inputSchema: NO_INPUT,
    annotations: { readOnlyHint: true },
    execute: async () => JSON.stringify({ muted: await deps.speechMute.load() }),
  },
  {
    name: 'set_speech_mute',
    title: '読み上げをミュートする',
    description: 'チャットの読み上げをミュートする（true）か、ミュートを解除します（false）。ミュート中に届いたコメントは、解除したあとも読み上げません。',
    inputSchema: {
      type: 'object',
      properties: { muted: { type: 'boolean' } },
      required: ['muted'],
    },
    execute: async (input) => {
      const muted = await deps.speechMute.save(readBoolean(input, 'muted'))
      return muted ? 'チャットの読み上げをミュートしました' : 'チャットの読み上げのミュートを解除しました'
    },
  },
  {
    name: 'get_transcription',
    title: '文字起こしの状態',
    description:
      '配信中の文字起こし（このタブの音声認識）がオンかどうかと、認識の様子（phase: off・unsupported・waiting・running・failed）を返します。failed のときは error に理由が入ります。',
    inputSchema: NO_INPUT,
    annotations: { readOnlyHint: true },
    execute: () => {
      const { enabled, phase, error } = deps.recognition()
      return JSON.stringify({ enabled, phase, error })
    },
  },
  {
    name: 'set_transcription',
    title: '文字起こしを切り替える',
    description: '配信中の文字起こし（このタブの音声認識）をオン（true）・オフ（false）にします。',
    inputSchema: {
      type: 'object',
      properties: { enabled: { type: 'boolean' } },
      required: ['enabled'],
    },
    execute: (input) => {
      const enabled = readBoolean(input, 'enabled')
      deps.recognition().setEnabled(enabled)
      // マイクの許可は、ページのボタンを押したとき（利用者の操作）でないと求められないことがある（recognition-context.tsx）
      if (enabled) return '文字起こしをオンにしました。マイクの許可を求められたときは、配信者が下部バーの文字起こしのボタンを押す必要があります'
      return '文字起こしをオフにしました'
    },
  },
  ...buildBroadcastTools(deps.apis),
  ...buildRecordTools(deps.apis, deps.now),
]
