/**
 * ポモドーロの設定（休憩中に流す曲）
 *
 * ポモドーロのタイマー（issue #208）で配信者が決めるのは、休憩中に流すBGMの曲だけである。作業と休憩の長さ（25分・5分）は
 * src/pomodoro/phase.ts に決め切ってあり、設定にしない（docs/principles.md の1「既定を決め切る」）。
 * 曲は BGM の一覧（worker/bgm-config.ts）から1つ選ぶ。「流したい場面」の自由記述と照らし合わせて選ぶ形は、
 * 当たり外れが曖昧になるので採らない（docs/decisions/pomodoro.md）。
 *
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない。休憩に入った時点で曲が一覧から消えていれば、
 *   切り替える側（worker/pomodoro-bgm.ts）が投げて失敗として記録する。
 */
import { ConfigError } from './alert-config'
import type { KeyValueStore } from './store'

const SETTINGS_KEY = 'pomodoro-settings'
/** 問題点のメッセージに出す、何の設定かの名前 */
const SUBJECT = 'ポモドーロの設定'

/** ポモドーロの設定 */
export interface PomodoroSettings {
  /** 休憩中に流す曲の素材のID（BGMの一覧にあるもの）。null なら休憩中も曲を変えない */
  readonly breakMediaId: string | null
}

/** 未保存のときの設定。曲を選ぶまでは、休憩に入っても BGM を変えない */
export const DEFAULT_POMODORO_SETTINGS: PomodoroSettings = { breakMediaId: null }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 管理画面から送られてきたポモドーロの設定を検証する。
 *
 * @param input `{ breakMediaId: string | null }`
 * @param trackMediaIds BGMの一覧にある曲の素材のID
 * @throws ConfigError 問題がある場合
 */
export const parsePomodoroSettings = (input: unknown, trackMediaIds: readonly string[]): PomodoroSettings => {
  if (!isRecord(input) || !('breakMediaId' in input)) throw new ConfigError(SUBJECT, ['breakMediaId: 曲の素材のIDか null で指定してください'])
  const { breakMediaId } = input
  if (breakMediaId === null) return { breakMediaId }
  if (typeof breakMediaId !== 'string' || !trackMediaIds.includes(breakMediaId)) {
    throw new ConfigError(SUBJECT, [`breakMediaId: 素材「${String(breakMediaId)}」の曲はBGMの一覧にありません`])
  }
  return { breakMediaId }
}

export const savePomodoroSettings = (store: KeyValueStore, settings: PomodoroSettings): Promise<void> => store.put(SETTINGS_KEY, JSON.stringify(settings))

/** 保存済みのポモドーロの設定を読む。未保存なら休憩中も曲を変えない */
export const loadPomodoroSettings = async (store: KeyValueStore): Promise<PomodoroSettings> => {
  const text = await store.get(SETTINGS_KEY)
  return text === null ? DEFAULT_POMODORO_SETTINGS : (JSON.parse(text) as PomodoroSettings)
}
