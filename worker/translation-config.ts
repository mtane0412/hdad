/**
 * 字幕の翻訳の設定（確定した発話をどの提供元で英語に訳すか）
 *
 * アプリの枠の音声認識が確定した発話を、Worker（worker/translation.ts）が訳して字幕に添える（issue #191）。
 * 提供元は次の4つから選ぶ。管理画面は /llm/ の「字幕の翻訳」の区画で、KVのキーは translation-settings である。
 * - off: 訳さない（既定。提供元を選ぶまで、料金も無料枠も使わない）
 * - llm: LLM に訳させる。提供元（Workers AI・OpenRouter）とモデルは LLM の設定の箇所 translation が決める（worker/llm-config.ts）
 * - m2m100: Workers AI の翻訳専用モデル @cf/meta/m2m100-1.2b
 * - deepl: DeepL API Free（鍵はWorkerのシークレット DEEPL_API_KEY）
 *
 * 注意: 訳す先の言語は英語だけで、設定項目にしない（docs/principles.md の方針1。経緯は docs/decisions/caption.md）。
 * 注意: DeepL の鍵はここには持たない。KVの設定にも管理画面の応答にも含めない（OpenRouter の鍵と同じ扱い）。
 */
import { ConfigError } from './alert-config'
import type { KeyValueStore } from './store'

const CONFIG_KEY = 'translation-settings'
/** 問題点のメッセージに出す、何の設定かの名前 */
const SUBJECT = '字幕の翻訳の設定'

/** 翻訳の提供元。並び順は管理画面の選択欄に出す順 */
export const TRANSLATION_PROVIDERS = ['off', 'llm', 'm2m100', 'deepl'] as const

export type TranslationProvider = (typeof TRANSLATION_PROVIDERS)[number]

/** 字幕の翻訳の設定 */
export interface TranslationSettings {
  readonly provider: TranslationProvider
}

/** 未保存のときに使う設定。訳さない（既定の提供元は、実配信で比べてから決める。issue #191） */
export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = { provider: 'off' }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 管理画面から送られてきた設定を検証し、保存用の形にする。
 *
 * @throws ConfigError 知らない提供元の場合（黙って「訳さない」に倒さない）
 */
export const parseTranslationSettings = (input: unknown): TranslationSettings => {
  if (!isRecord(input)) throw new ConfigError(SUBJECT, ['設定は provider を持つオブジェクトで指定してください'])
  const provider = input.provider
  if (!TRANSLATION_PROVIDERS.includes(provider as TranslationProvider)) {
    throw new ConfigError(SUBJECT, [`provider: ${TRANSLATION_PROVIDERS.join('・')} のどれかで指定してください`])
  }
  return { provider: provider as TranslationProvider }
}

export const saveTranslationSettings = (store: KeyValueStore, settings: TranslationSettings): Promise<void> =>
  store.put(CONFIG_KEY, JSON.stringify(settings))

/**
 * 保存済みの設定を読む。未保存なら既定の設定（訳さない）を返す。
 *
 * @throws Error 保存されている形が読めない場合（直し方を文面に出す。llm-config.ts と同じ）
 */
export const loadTranslationSettings = async (store: KeyValueStore): Promise<TranslationSettings> => {
  const text = await store.get(CONFIG_KEY)
  if (text === null) return DEFAULT_TRANSLATION_SETTINGS
  try {
    return parseTranslationSettings(JSON.parse(text))
  } catch (error) {
    throw new Error(
      `保存されている${SUBJECT}を読めません（${error instanceof Error ? error.message : String(error)}）。KVの ${CONFIG_KEY} を消してから、管理画面で保存し直してください`,
      { cause: error },
    )
  }
}
