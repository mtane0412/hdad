/**
 * LLMの設定（AIを使う箇所ごとに、どの提供元のどのモデルに作らせるか）
 *
 * このツールがLLMに文面を作らせる箇所は4つある（トリガーの動作 aiChat のチャットの文面・サイドスーパー・
 * 視聴者の人物像・配信のあらすじ）。呼び先は Cloudflare の Workers AI（Env.AI）だけとは限らないので、
 * 提供元とモデル名を箇所ごとにここへ持たせ、管理画面（/llm/）から変えられるようにする
 * （実際の呼び出しは worker/llm.ts）。作りは speech-config.ts・bot-config.ts・moderation-config.ts と
 * 同じで、問題点は最初の1件で止めずにすべて集めてから拒否する（管理画面で一度に直せるようにするため）。
 *
 * 注意: 提供元は箇所ごとに選ぶ。あらすじだけ賢いモデルに任せて、発言ごとに呼ばれるチャットの文面は
 * 無料枠の Workers AI に留める、といった使い分けができるようにするためである。
 * 注意: モデル名は提供元ごとに別に持つ。名前の付け方がまったく違う（Workers AI は @cf/…、OpenRouter は 提供者/モデル）ので、
 * 1つだけ持たせると提供元を切り替えるたびに書き直すことになり、切り替えて戻したときに前の名前も消える。
 * 注意: 使っていない提供元のモデル名も検証する。保存時に通った設定しか読み出しで再検証しない約束（speech-config.ts と同じ）なので、
 * 空のまま保存できてしまうと、提供元を切り替えた瞬間に初めて呼び出しが失敗することになる。
 * 注意: Workers AI のモデル名は候補の一覧（llm-models.ts の WORKERS_AI_MODELS）に載っているものだけを通す。
 * 一覧はこのリポジトリが持っていて、管理画面も同じ一覧から選ばせるので、外れた値は打ち間違いか古い設定である。
 * 一方 OpenRouter のモデル名は照らし合わせない。一覧は遠隔で日々変わるため、保存のたびに問い合わせることになり、
 * その問い合わせが失敗すると正しいモデル名まで拒んでしまう（呼び出しのときに OpenRouter が答える）。
 * 注意: OpenRouter のAPIキーはここには持たない。鍵はWorkerのシークレット（OPENROUTER_API_KEY）に置き、
 * KVの設定にも管理画面の応答にも含めない（トークンを応答に含めない約束と同じ）。
 */
import { ConfigError } from './alert-config'
import { WORKERS_AI_MODELS } from './llm-models'
import type { KeyValueStore } from './store'

const CONFIG_KEY = 'llm-settings'
/** 問題点のメッセージに出す、何の設定かの名前 */
const SUBJECT = 'LLMの設定'

/** 呼び先。workers-ai は Cloudflare のバインディング（Env.AI）、openrouter は OpenRouter のAPI */
export const LLM_PROVIDERS = ['workers-ai', 'openrouter'] as const

/**
 * LLMに文面を作らせる箇所。
 *
 * 並び順は管理画面に出す順で、発言ごとに呼ばれるもの（aiChat）から、cron が5分おきに呼ぶもの
 * （sideSuper・viewerSummary・streamSummary）へと並べる。
 */
export const LLM_USAGES = ['aiChat', 'sideSuper', 'viewerSummary', 'streamSummary'] as const

export type LlmProvider = (typeof LLM_PROVIDERS)[number]
export type LlmUsage = (typeof LLM_USAGES)[number]

/** 提供元ごとのモデル名 */
export type LlmModels = Readonly<Record<LlmProvider, string>>

/** 1か所ぶんの設定 */
export interface LlmUsageSettings {
  /** いま使う提供元 */
  readonly provider: LlmProvider
  /** 提供元ごとのモデル名。選んでいないほうも覚えておく */
  readonly models: LlmModels
}

/** LLMの設定 */
export interface LlmSettings {
  readonly usages: Readonly<Record<LlmUsage, LlmUsageSettings>>
}

/** 短い文をたくさん作る箇所の既定のモデル。無料枠の中で何度も呼べる軽さで選んでいる */
const LIGHT_MODELS: LlmModels = { 'workers-ai': '@cf/meta/llama-3.1-8b-instruct-fp8', openrouter: 'meta-llama/llama-3.1-8b-instruct' }

/**
 * あらすじの既定のモデル。ここだけ大きいものを使う。
 *
 * 8bでは、視聴者の書き込みを配信者のした出来事として書く・「〜と言いました」を延々と並べる・同じ句を
 * 繰り返して上限の文字数を超える、といった壊れ方が実際の配信で起きたためである（同じ材料で比べて確かめた）。
 * あらすじは配信の記録すべてを材料にする唯一の箇所で、5分に1回しか作らないので、Workers AI の無料枠
 * （1日10,000 Neurons）に対しては1回あたり約63 Neurons に収まる
 * （Neuronsの単価は https://developers.cloudflare.com/workers-ai/platform/pricing/ ）。
 */
const LARGE_MODELS: LlmModels = { 'workers-ai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast', openrouter: 'meta-llama/llama-3.3-70b-instruct' }

/**
 * 未保存のときに使う設定。
 *
 * 提供元はどこも Workers AI（無料枠だけで動くため）。モデル名は、これまで使っていた値をそのまま既定にする。
 * OpenRouter 側の既定も同じ系統のモデルにして、提供元を切り替えただけで文体が変わらないようにする。
 */
export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  usages: {
    aiChat: { provider: 'workers-ai', models: LIGHT_MODELS },
    sideSuper: { provider: 'workers-ai', models: LIGHT_MODELS },
    viewerSummary: { provider: 'workers-ai', models: LIGHT_MODELS },
    streamSummary: { provider: 'workers-ai', models: LARGE_MODELS },
  },
}

/** モデル名の長さの上限。提供者名を含めても収まる長さにし、際限なく長い文字列をKVへ保存させない */
const MAX_MODEL_LENGTH = 200

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 管理画面から送られてきた設定を検証し、保存用の形にする。
 *
 * @throws ConfigError 問題が1件でもある場合
 */
export const parseLlmSettings = (input: unknown): LlmSettings => {
  if (!isRecord(input) || !isRecord(input.usages)) throw new ConfigError(SUBJECT, ['設定は usages を持つオブジェクトで指定してください'])
  const given = input.usages

  const problems: string[] = []

  /** 提供元を読む。知らない名前は黙って既定に倒さず拒む（Fail-Fast） */
  const readProvider = (usage: LlmUsage, value: unknown): LlmProvider => {
    if (LLM_PROVIDERS.includes(value as LlmProvider)) return value as LlmProvider
    problems.push(`${usage}.provider: ${LLM_PROVIDERS.join(' か ')} で指定してください`)
    return DEFAULT_LLM_SETTINGS.usages[usage].provider
  }

  /**
   * 提供元ごとのモデル名を読む。範囲の外なら問題点に積み、既定の値で埋める
   * （問題点が1件でもあれば保存しないので、埋めた値は使われない）。
   */
  const readModels = (usage: LlmUsage, value: unknown): LlmModels => {
    if (!isRecord(value)) {
      problems.push(`${usage}.models: 提供元ごとのモデル名をオブジェクトで指定してください`)
      return DEFAULT_LLM_SETTINGS.usages[usage].models
    }
    const models = LLM_PROVIDERS.map((provider): [LlmProvider, string] => {
      const model = value[provider]
      if (typeof model !== 'string' || model.trim() === '' || model.trim().length > MAX_MODEL_LENGTH) {
        problems.push(`${usage}.models.${provider}: モデル名を${MAX_MODEL_LENGTH}文字以内で指定してください`)
        return [provider, DEFAULT_LLM_SETTINGS.usages[usage].models[provider]]
      }
      const trimmed = model.trim()
      if (provider === 'workers-ai' && !WORKERS_AI_MODELS.some(({ id }) => id === trimmed)) {
        problems.push(`${usage}.models.workers-ai: Workers AI で選べるモデルから指定してください（${trimmed} は候補にありません）`)
        return [provider, DEFAULT_LLM_SETTINGS.usages[usage].models[provider]]
      }
      return [provider, trimmed]
    })
    return Object.fromEntries(models) as LlmModels
  }

  /** 1か所ぶんを読む。欠けていても既定で埋めず、足りないことを問題点として知らせる */
  const readUsage = (usage: LlmUsage): LlmUsageSettings => {
    const value = given[usage]
    if (!isRecord(value)) {
      problems.push(`${usage}: 提供元（provider）とモデル名（models）をオブジェクトで指定してください`)
      return DEFAULT_LLM_SETTINGS.usages[usage]
    }
    return { provider: readProvider(usage, value.provider), models: readModels(usage, value.models) }
  }

  // 呼ぶ順番が、問題点に並ぶ順番になる
  const usages = Object.fromEntries(LLM_USAGES.map((usage) => [usage, readUsage(usage)])) as Record<LlmUsage, LlmUsageSettings>

  if (problems.length > 0) throw new ConfigError(SUBJECT, problems)
  return { usages }
}

export const saveLlmSettings = (store: KeyValueStore, settings: LlmSettings): Promise<void> => store.put(CONFIG_KEY, JSON.stringify(settings))

/**
 * 保存済みの設定を読む。未保存なら既定の設定を返す。
 *
 * 注意: 保存されている形が古ければ（用途を chat・summary の2つにまとめていたころの形など）、読み替えずに
 * エラーにする（Fail-Fast。alert-config.ts の loadAlertConfig と同じ考え方で、開発中で後方互換を保つ必要が
 * ないため、暗黙の読み替えを増やさない）。管理画面もこの読み出しを通るので、直すにはKVのキーを消してから
 * 入れ直す。その手だてをエラーの文面に書く。
 */
export const loadLlmSettings = async (store: KeyValueStore): Promise<LlmSettings> => {
  const text = await store.get(CONFIG_KEY)
  if (text === null) return DEFAULT_LLM_SETTINGS
  try {
    return parseLlmSettings(JSON.parse(text))
  } catch (error) {
    throw new Error(
      `保存されている${SUBJECT}を読めません（${error instanceof Error ? error.message : String(error)}）。KVの ${CONFIG_KEY} を消してから、管理画面で保存し直してください`,
      { cause: error },
    )
  }
}
