/**
 * LLMの設定（どの提供元のどのモデルに文面を作らせるか）
 *
 * 文面づくり（ai-chat.ts）・あらすじ（stream-summary.ts）・サイドスーパー（side-super.ts）・人物像（viewer-summary.ts）は
 * どれもLLMを呼ぶが、呼び先は Cloudflare の Workers AI（Env.AI）だけとは限らない。OpenRouter も試せるように、
 * 提供元とモデル名をここに持たせ、管理画面（/llm/）から変えられるようにする（実際の呼び出しは worker/llm.ts）。
 * 作りは speech-config.ts・bot-config.ts・moderation-config.ts と同じで、問題点は最初の1件で止めずに
 * すべて集めてから拒否する（管理画面で一度に直せるようにするため）。
 *
 * 注意: モデル名は提供元ごとに別に持つ。名前の付け方がまったく違う（Workers AI は @cf/…、OpenRouter は 提供者/モデル）ので、
 * 1組だけ持たせると提供元を切り替えるたびに両方を書き直すことになり、切り替えて戻したときに前の名前も消える。
 * 注意: 使っていない提供元のモデル名も検証する。保存時に通った設定しか読み出しで再検証しない約束（speech-config.ts と同じ）なので、
 * 空のまま保存できてしまうと、提供元を切り替えた瞬間に初めて呼び出しが失敗することになる。
 * 注意: OpenRouter のAPIキーはここには持たない。鍵はWorkerのシークレット（OPENROUTER_API_KEY）に置き、
 * KVの設定にも管理画面の応答にも含めない（トークンを応答に含めない約束と同じ）。
 */
import { ConfigError } from './alert-config'
import type { KeyValueStore } from './store'

const CONFIG_KEY = 'llm-settings'
/** 問題点のメッセージに出す、何の設定かの名前 */
const SUBJECT = 'LLMの設定'

/** 呼び先。workers-ai は Cloudflare のバインディング（Env.AI）、openrouter は OpenRouter のAPI */
export const LLM_PROVIDERS = ['workers-ai', 'openrouter'] as const

/** 文面を作らせる用途。chat はチャットの文面・サイドスーパー・人物像、summary は配信のあらすじ（worker/llm.ts） */
export const LLM_PURPOSES = ['chat', 'summary'] as const

export type LlmProvider = (typeof LLM_PROVIDERS)[number]
export type LlmPurpose = (typeof LLM_PURPOSES)[number]

/** 用途ごとのモデル名 */
export type LlmModels = Readonly<Record<LlmPurpose, string>>

/** LLMの設定 */
export interface LlmSettings {
  /** いま使う提供元 */
  readonly provider: LlmProvider
  /** Workers AI を使うときのモデル名 */
  readonly workersAi: LlmModels
  /** OpenRouter を使うときのモデル名 */
  readonly openrouter: LlmModels
}

/**
 * 未保存のときに使う設定。
 *
 * 提供元は Workers AI（無料枠だけで動くため）。モデル名は、これまで使っていた値をそのまま既定にする。
 * OpenRouter 側の既定も同じ系統のモデルにして、提供元を切り替えただけで文体が変わらないようにする。
 *
 * あらすじ（summary）だけ大きいモデルを使う。8bでは、視聴者の書き込みを配信者のした出来事として書く・
 * 「〜と言いました」を延々と並べる・同じ句を繰り返して上限の文字数を超える、といった壊れ方が実際の配信で
 * 起きたためである（同じ材料で比べて確かめた）。あらすじは配信の記録すべてを材料にする唯一の用途で、
 * 5分に1回しか作らないので、Workers AI の無料枠（1日10,000 Neurons）に対しては1回あたり約63 Neurons に収まる
 * （Neuronsの単価は https://developers.cloudflare.com/workers-ai/platform/pricing/ ）。
 */
export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  provider: 'workers-ai',
  workersAi: { chat: '@cf/meta/llama-3.1-8b-instruct-fp8', summary: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
  openrouter: { chat: 'meta-llama/llama-3.1-8b-instruct', summary: 'meta-llama/llama-3.3-70b-instruct' },
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
  if (!isRecord(input)) throw new ConfigError(SUBJECT, ['設定はオブジェクトで指定してください'])

  const problems: string[] = []

  /** 提供元を読む。知らない名前は黙って既定に倒さず拒む（Fail-Fast） */
  const readProvider = (): LlmProvider => {
    const value = input.provider
    if (LLM_PROVIDERS.includes(value as LlmProvider)) return value as LlmProvider
    problems.push(`provider: ${LLM_PROVIDERS.join(' か ')} で指定してください`)
    return DEFAULT_LLM_SETTINGS.provider
  }

  /**
   * 提供元ごとのモデル名を読む。範囲の外なら問題点に積み、既定の値で埋める
   * （問題点が1件でもあれば保存しないので、埋めた値は使われない）。
   */
  const readModels = (name: 'workersAi' | 'openrouter'): LlmModels => {
    const value = input[name]
    if (!isRecord(value)) {
      problems.push(`${name}: 用途ごとのモデル名をオブジェクトで指定してください`)
      return DEFAULT_LLM_SETTINGS[name]
    }
    const models = LLM_PURPOSES.map((purpose): [LlmPurpose, string] => {
      const model = value[purpose]
      if (typeof model !== 'string' || model.trim() === '' || model.trim().length > MAX_MODEL_LENGTH) {
        problems.push(`${name}.${purpose}: モデル名を${MAX_MODEL_LENGTH}文字以内で指定してください`)
        return [purpose, DEFAULT_LLM_SETTINGS[name][purpose]]
      }
      return [purpose, model.trim()]
    })
    return Object.fromEntries(models) as LlmModels
  }

  // 呼ぶ順番が、問題点に並ぶ順番になる
  const provider = readProvider()
  const workersAi = readModels('workersAi')
  const openrouter = readModels('openrouter')

  if (problems.length > 0) throw new ConfigError(SUBJECT, problems)
  return { provider, workersAi, openrouter }
}

export const saveLlmSettings = (store: KeyValueStore, settings: LlmSettings): Promise<void> => store.put(CONFIG_KEY, JSON.stringify(settings))

/**
 * 保存済みの設定を読む。未保存なら既定の設定を返す。
 *
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない（speech-config.ts と同じ）。
 */
export const loadLlmSettings = async (store: KeyValueStore): Promise<LlmSettings> => {
  const text = await store.get(CONFIG_KEY)
  return text === null ? DEFAULT_LLM_SETTINGS : (JSON.parse(text) as LlmSettings)
}
