/**
 * 字幕の翻訳（確定した発話1件を英語に訳す）
 *
 * アプリの枠の音声認識が確定した発話を、POST /api/admin/translations（worker/translation-routes.ts）から受け取って訳す
 * （issue #191）。提供元は設定（worker/translation-config.ts。KVは translation-settings）が決める。
 * - llm: LLM の唯一の入口（worker/llm.ts）に箇所 translation を指名して頼む。提供元とモデルは LLM の設定が決め、
 *   使用状況も llm.ts が記録する
 * - m2m100: Workers AI の翻訳専用モデル。文脈を受け取れないので、いまの1件だけを渡す
 * - deepl: DeepL API Free。直前の発話は context で渡す（context の文字は課金されない）
 *
 * 注意: 暫定の認識は訳さない（何度も書き換わり、料金と字幕のちらつきが増えるため）。ここへ届くのは確定した1件だけである。
 * 注意: 失敗は黙って別の提供元へ落とさずに投げる（docs/decisions/llm.md と同じ）。訳せなかった1件のために
 * 原文の字幕が止まらないよう、原文は訳を待たずに字幕へ送られている（src/transcript/recognition-context.tsx）。
 * 注意: LLM を通さない提供元の使用状況は、ここで llm_usage の箇所 translation へ足し込む（失敗も数える）。記録に
 * 失敗しても訳文は返す（llm.ts の recordUsage と同じ考え方）。
 * 注意: 設定（KV）は呼ばれるたびに読む。経路の処理ごとに作り直すもので、1回の要求で1件しか訳さないためである。
 */
import type { Database } from './database'
import type { LlmMessage, TextGenerator, WorkersAi } from './llm'
import { recordLlmUsage, type UsageProvider } from './llm-usage-store'
import { recordFailure } from './stats-store'
import { loadTranslationSettings } from './translation-config'
import { runWithTimeout, withTimeout } from './timeout'
import type { KeyValueStore } from './store'

/** Workers AI の翻訳専用モデル */
export const M2M100_MODEL = '@cf/meta/m2m100-1.2b'

/** 使用状況に記録する DeepL のモデル名（DeepL にモデルの選択は無いので、無料版を使っていることを記す） */
export const DEEPL_MODEL = 'deepl-free'

/** DeepL API Free の入口（有料版は api.deepl.com で、鍵の末尾が :fx でない） */
const DEEPL_TRANSLATE_URL = 'https://api-free.deepl.com/v2/translate'
const DEEPL_USAGE_URL = 'https://api-free.deepl.com/v2/usage'

/**
 * LLM 以外の提供元の1回を待つ時間の上限（ミリ秒）。
 *
 * 字幕の確定した行は6秒で消える（src/caption/captions.ts の FINAL_LIFETIME_MS）ので、それより遅い訳は添える先が無い。
 * 黙った相手を待ち続けないよう、値を引くだけの Twitch・Gyazo と同じ程度で切る。
 */
export const TRANSLATION_TIMEOUT_MS = 15_000

/**
 * LLM に作らせる訳文の長さの上限（トークン）。
 *
 * 1件の発話は平均14文字ほどで、長くても上限の1000文字（worker/transcript-routes.ts の TRANSCRIPT_MAX_LENGTH）である。
 * ふつうの発話を切らずに訳せる長さにとどめ、壊れた応答が延々と続かないようにする。
 */
const LLM_MAX_TOKENS = 300

/** 失敗の文面に載せる応答本文の長さ。理由が読める程度にとどめる */
const MAX_ERROR_BODY_LENGTH = 200

/** 訳してほしい1件 */
export interface TranslationRequest {
  /** いま確定した発話 */
  readonly text: string
  /** 直前に確定した発話（古いものから）。訳の手がかりにするだけで、訳さない */
  readonly context: readonly string[]
}

/** 訳すもの */
export interface Translator {
  /**
   * 1件を英語に訳す。
   *
   * @returns 訳文。設定が「訳さない」なら null
   * @throws Error 提供元が失敗した・鍵が無い・応答の形が違う・訳文が空の場合
   */
  translate(request: TranslationRequest): Promise<string | null>
}

/** 組み立てに必要なもの */
export interface TranslatorOptions {
  /** 設定（translation-settings）を置いてあるストア（KV） */
  store: KeyValueStore
  /** LLM の唯一の入口（worker/llm.ts）。提供元に LLM を選んだときだけ呼ぶ */
  llm: TextGenerator
  /** Cloudflare の Workers AI のバインディング（Env.AI）。m2m100 を呼ぶ */
  ai: WorkersAi
  /** DeepL への通信。テストで差し替えられるよう引数で受け取る */
  fetch: typeof fetch
  /** DeepL のAPIキー（Workerのシークレット DEEPL_API_KEY）。未設定なら undefined */
  deeplApiKey: string | undefined
  /** 使用状況を記録するデータベース（D1。llm_usage と、記録に失敗したときの collection_failures） */
  db: Database
  /** 現在時刻（ミリ秒）を返すもの。記録する日の区切りに使う */
  now: () => number
}

/** LLM への指示。訳文だけを返させ、前置きや注釈で字幕が長くならないようにする */
const LLM_INSTRUCTION =
  'You translate a Japanese live streamer\'s speech into natural, casual English for on-screen subtitles. ' +
  'The previous lines are given only as context; do not translate them. ' +
  'Reply with the English translation of the last line only, without quotes, notes, or romaji.'

/** LLM へ渡す発言を組み立てる。直前の発話があれば、訳す1件と分けて添える */
export const buildTranslationMessages = ({ text, context }: TranslationRequest): LlmMessage[] => {
  const previous = context.length > 0 ? `Previous lines:\n${context.join('\n')}\n\n` : ''
  return [
    { role: 'system', content: LLM_INSTRUCTION },
    { role: 'user', content: `${previous}Line to translate:\n${text}` },
  ]
}

/** 訳文の前後の空白を落とす。空なら訳せなかったものとして投げる（空の行を字幕に添えない） */
const requireText = (value: unknown, source: string): string => {
  const translated = typeof value === 'string' ? value.trim() : ''
  if (translated === '') throw new Error(`${source} から訳文を受け取れませんでした: ${JSON.stringify(value)}`)
  return translated
}

/** DeepL の鍵があることを確かめる */
const requireDeeplKey = (apiKey: string | undefined): string => {
  if (apiKey === undefined || apiKey === '') {
    throw new Error('字幕の翻訳に DeepL を選んでいますが、WorkerのシークレットDEEPL_API_KEYが設定されていません')
  }
  return apiKey
}

/** DeepL が失敗を返したときの文面（403 は鍵の誤り、456 は今月の上限に達したことを表す） */
const deeplError = async (response: Response): Promise<Error> => {
  const body = (await response.text()).slice(0, MAX_ERROR_BODY_LENGTH)
  return new Error(`DeepL が失敗を返しました（${response.status}）: ${body}`)
}

/** Workers AI の m2m100 に訳させる */
const translateWithM2m100 = async (ai: WorkersAi, text: string): Promise<string> => {
  const result = await runWithTimeout(() => ai.run(M2M100_MODEL, { text, source_lang: 'ja', target_lang: 'en' }), TRANSLATION_TIMEOUT_MS, 'Workers AI')
  const translated: unknown = typeof result === 'object' && result !== null ? (result as Record<string, unknown>).translated_text : undefined
  return requireText(translated, `Workers AI（${M2M100_MODEL}）`)
}

/** DeepL に訳させる。直前の発話は課金されない context で渡す */
const translateWithDeepl = async (fetchImpl: typeof fetch, apiKey: string, { text, context }: TranslationRequest): Promise<string> => {
  const response = await fetchImpl(DEEPL_TRANSLATE_URL, {
    method: 'POST',
    headers: { Authorization: `DeepL-Auth-Key ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: [text], source_lang: 'JA', target_lang: 'EN-US', ...(context.length > 0 ? { context: context.join('\n') } : {}) }),
  })
  if (!response.ok) throw await deeplError(response)
  const body: unknown = await response.json()
  const translations = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).translations : undefined
  const first: unknown = Array.isArray(translations) ? translations[0] : undefined
  return requireText(typeof first === 'object' && first !== null ? (first as Record<string, unknown>).text : undefined, 'DeepL')
}

/** 設定に従って訳すものを組み立てる */
export const createTranslator = ({ store, llm, ai, fetch: originalFetch, deeplApiKey, db, now }: TranslatorOptions): Translator => {
  // DeepL が黙り続けたときに、待ち続けないようにする
  const fetchImpl = withTimeout(originalFetch, TRANSLATION_TIMEOUT_MS, 'DeepL')

  /**
   * LLM を通さない提供元の1回を記録する。
   *
   * 記録できなくても投げない（訳文は受け取れているので、記録のために字幕の訳を失わない）。
   * 黙って捨てず collection_failures へ残し、その記録まで失敗したらあきらめる（llm.ts の recordUsage と同じ）。
   */
  const recordUsage = async (provider: UsageProvider, model: string, failed: boolean): Promise<void> => {
    const time = now()
    try {
      await recordLlmUsage(db, { usage: 'translation', provider, model, promptTokens: 0, completionTokens: 0, costUsd: 0, failed }, time)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await recordFailure(db, 'llm-usage-record-failed', `字幕の翻訳の使用状況（${model}）を記録できませんでした: ${message}`, time).catch(() => undefined)
    }
  }

  /** LLM を通さない提供元を呼び、成功も失敗も数える */
  const counted = async (provider: UsageProvider, model: string, call: () => Promise<string>): Promise<string> => {
    const translated = await call().catch(async (error: unknown) => {
      await recordUsage(provider, model, true)
      throw error
    })
    await recordUsage(provider, model, false)
    return translated
  }

  return {
    translate: async (request) => {
      const { provider } = await loadTranslationSettings(store)
      switch (provider) {
        case 'off':
          return null
        case 'llm':
          return requireText(await llm.run('translation', { messages: buildTranslationMessages(request), maxTokens: LLM_MAX_TOKENS }), 'LLM')
        case 'm2m100':
          return counted('workers-ai', M2M100_MODEL, () => translateWithM2m100(ai, request.text))
        case 'deepl': {
          const apiKey = requireDeeplKey(deeplApiKey)
          return counted('deepl', DEEPL_MODEL, () => translateWithDeepl(fetchImpl, apiKey, request))
        }
      }
    },
  }
}

/** DeepL の今月の使用量 */
export interface DeeplUsage {
  /** 今月訳した文字数 */
  readonly characterCount: number
  /** 今月訳せる文字数の上限（Free は50万字） */
  readonly characterLimit: number
}

/**
 * DeepL の今月の使用量を読む（管理画面で無料枠の残りを出すため）。
 *
 * @throws Error DeepL が失敗を返した・想定した形でない場合（0 として見せない）
 */
export const readDeeplUsage = async ({ fetch: fetchImpl, apiKey }: { fetch: typeof fetch; apiKey: string }): Promise<DeeplUsage> => {
  const response = await withTimeout(fetchImpl, TRANSLATION_TIMEOUT_MS, 'DeepL')(DEEPL_USAGE_URL, { headers: { Authorization: `DeepL-Auth-Key ${apiKey}` } })
  if (!response.ok) throw await deeplError(response)
  const body: unknown = await response.json()
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const { character_count: characterCount, character_limit: characterLimit } = record
  if (typeof characterCount !== 'number' || typeof characterLimit !== 'number') {
    throw new Error(`DeepL の使用量を読めません: ${JSON.stringify(body)}`)
  }
  return { characterCount, characterLimit }
}
