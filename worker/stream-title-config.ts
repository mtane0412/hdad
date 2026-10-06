/**
 * 配信タイトルの候補づくりの設定（試験運用。issue #268）
 *
 * 章が切り替わるたびに配信タイトルの候補を作るか（worker/stream-title.ts）を、ストア（KV）の stream-title-settings に持つ。
 * 未保存なら作らない。候補の判定には Jev（OpenRouter の鍵が要る）を使い、候補づくりには大きいモデルを使うので、
 * 配信者が入れたときだけ動かす（鍵の無い環境で、毎回の失敗とLLMの呼び出しを積み上げないため）。
 */
import { ConfigError } from './alert-config'
import type { KeyValueStore } from './store'

const SETTINGS_KEY = 'stream-title-settings'

/** 検証の失敗の文面に出す、設定の名前 */
const SUBJECT = '配信タイトルの候補の設定'

/** 配信タイトルの候補づくりの設定 */
export interface StreamTitleSettings {
  /** 章が切り替わるたびに、配信タイトルの候補を作って記録するか */
  readonly enabled: boolean
}

/** 未保存のときの設定。配信者が入れたときだけ作る */
export const DEFAULT_STREAM_TITLE_SETTINGS: StreamTitleSettings = { enabled: false }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 管理画面から送られてきた設定を検証する。
 *
 * @param input `{ enabled: boolean }`
 * @throws ConfigError 問題がある場合
 */
export const parseStreamTitleSettings = (input: unknown): StreamTitleSettings => {
  if (!isRecord(input)) throw new ConfigError(SUBJECT, ['設定はオブジェクトで指定してください'])
  const { enabled } = input
  if (typeof enabled !== 'boolean') throw new ConfigError(SUBJECT, ['enabled: true か false で指定してください'])
  return { enabled }
}

export const saveStreamTitleSettings = (store: KeyValueStore, settings: StreamTitleSettings): Promise<void> =>
  store.put(SETTINGS_KEY, JSON.stringify(settings))

/**
 * 保存済みの設定を読む。未保存なら候補を作らない。
 *
 * @throws ConfigError 保存されている形が壊れている場合（黙って「作らない」にしない）
 */
export const loadStreamTitleSettings = async (store: KeyValueStore): Promise<StreamTitleSettings> => {
  const text = await store.get(SETTINGS_KEY)
  return text === null ? DEFAULT_STREAM_TITLE_SETTINGS : parseStreamTitleSettings(JSON.parse(text))
}
