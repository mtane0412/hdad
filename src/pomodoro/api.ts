/**
 * ポモドーロの Worker の呼び出し
 *
 * 2つの呼び出し手がある。
 * - 合成ページの素材「ポモドーロ」: ログインを持たないので、オーバーレイ用キー（URLの ?key=）で Worker に受け付けてもらう。
 *   タイマーが変わるたびに WebSocket（POMODORO_SOCKET_PATH）で押し出してもらい、ここで読むのは開いたとき・つなぎ直したとき・定期的に取り戻す分だけである
 * - アプリのページ（/pomodoro/）: ログインのセッションで、タイマーと休憩の曲の設定を読み、休憩の曲を保存し、タイマーを操作する
 *
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: 想定した形でなければエラーにする（Fail-Fast）。タイマーの形の確かめは phase.ts の readPomodoroSnapshot だけが持つ。
 */
import { createCaller, isRecord } from '../core/api'
import { readPomodoroSnapshot, type PomodoroTimer } from './phase'

const OVERLAY_PATH = '/api/overlay/pomodoro'
const ADMIN_PATH = '/api/admin/pomodoro'
const SETTINGS_PATH = `${ADMIN_PATH}/settings`
const CONTROL_PATH = `${ADMIN_PATH}/control`

/** 変わったタイマーを押し出してもらう WebSocket のパス */
export const POMODORO_SOCKET_PATH = '/api/overlay/pomodoro/socket'

/** 一度もつながらないまま閉じたときに出す、いちばんありそうな原因 */
export const POMODORO_SOCKET_HINT = 'ポモドーロのタイマーの配送先につながりません。URLのオーバーレイ用キーが正しいか確かめてください'

/** タイマーの操作。worker/pomodoro-timer.ts の POMODORO_COMMANDS と合わせる */
export type PomodoroCommand = 'start' | 'pause' | 'resume' | 'stop'

/** ポモドーロの設定。worker/pomodoro-config.ts の PomodoroSettings と合わせる */
export interface PomodoroSettings {
  /** 休憩中に流す曲の素材のID（BGMの一覧にあるもの）。null なら休憩中も曲を変えない */
  readonly breakMediaId: string | null
}

export interface PomodoroOverlayApi {
  /** いまのタイマーを読む。止めていれば null */
  read(): Promise<PomodoroTimer | null>
}

export interface PomodoroApi {
  /** いまのタイマー（止めていれば null）と、休憩の曲の設定を読む */
  read(): Promise<{ timer: PomodoroTimer | null; settings: PomodoroSettings }>
  /** 休憩の曲を保存し、保存した設定を返す */
  saveSettings(settings: PomodoroSettings): Promise<PomodoroSettings>
  /** タイマーを操作し、操作したあとのタイマーを返す（止めたら null） */
  control(command: PomodoroCommand): Promise<PomodoroTimer | null>
}

/**
 * 応答の settings を読む。
 *
 * @throws 想定した形でない場合
 */
const readSettings = (body: unknown): PomodoroSettings => {
  const settings = isRecord(body) ? body.settings : undefined
  if (!isRecord(settings) || !(typeof settings.breakMediaId === 'string' || settings.breakMediaId === null)) {
    throw new Error('ポモドーロの設定の応答の形が想定と違います')
  }
  return { breakMediaId: settings.breakMediaId }
}

/**
 * 合成ページからの読み出しを組み立てる。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 * @param key オーバーレイ用キー
 */
export const createPomodoroOverlayApi = (fetchImpl: typeof fetch, key: string): PomodoroOverlayApi => {
  const call = createCaller(fetchImpl)
  const path = `${OVERLAY_PATH}?key=${encodeURIComponent(key)}`
  return {
    read: async () => readPomodoroSnapshot(await call(path)),
  }
}

/**
 * アプリのページからの読み書きを組み立てる。
 *
 * @param fetchImpl 通信の実装（同上）
 */
export const createPomodoroApi = (fetchImpl: typeof fetch): PomodoroApi => {
  const call = createCaller(fetchImpl)
  const send = (path: string, method: string, body: unknown): Promise<unknown> =>
    call(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  return {
    read: async () => {
      const body = await call(ADMIN_PATH)
      return { timer: readPomodoroSnapshot(body), settings: readSettings(body) }
    },
    saveSettings: async (settings) => readSettings(await send(SETTINGS_PATH, 'PUT', settings)),
    control: async (command) => readPomodoroSnapshot(await send(CONTROL_PATH, 'POST', { command })),
  }
}
