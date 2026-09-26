/**
 * 選べるモデルの一覧
 *
 * 管理画面（/llm/）のモデルの選択欄に出す候補を返す。モデル名を手で入力させると、打ち間違いに気づくのが
 * 「配信中に文面が作られなかったとき」になってしまうため、選ぶ形にしている。
 * 出どころは提供元ごとに違う。
 * - Workers AI: このファイルが持つ一覧（WORKERS_AI_MODELS）。通信しない
 * - OpenRouter: 公開API（https://openrouter.ai/api/v1/models）。鍵は要らない
 *
 * 注意: Workers AI の一覧を手で持つのは、Cloudflare のモデル一覧のAPIがアカウント単位のAPIトークンを
 * 必要とし、このWorkerはそれを持たないためである（持たせると、モデルを選ぶだけのために強い鍵を増やすことになる）。
 * モデルが増えたらここに足す（素材の registry.ts と同じ扱い）。
 * 注意: 一覧は滅多に変わらないので、OpenRouter から取ったものはKVに1時間貯める（chat-routes.ts と同じ考え方）。
 * 注意: 取れなかったときは空の一覧を返さずに投げる（Fail-Fast）。空の選択欄を出すと、配信者は
 * 「選べるモデルが無い」のか「一覧を取れていない」のか見分けられない。
 */
import type { LlmProvider } from './llm-config'
import type { KeyValueStore } from './store'

/** OpenRouter が公開しているモデルの一覧 */
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'

/** KVに貯めるキーと、貯めておく時間（ミリ秒） */
const CACHE_KEY = 'openrouter-models'
const CACHE_TTL_MS = 60 * 60 * 1000

/** 選択欄に出す1件 */
export interface LlmModelOption {
  /** 設定に保存するモデル名 */
  readonly id: string
  /** 画面に出す名前 */
  readonly name: string
}

/**
 * Workers AI で選べるモデル。
 *
 * 文章を作らせる用途に向く汎用のモデルだけを載せる。次のものは載せていない。
 * - LoRA の土台（`…-lora`）: 単体で指示に従わせるものではない
 * - コード専用（`qwen2.5-coder`・`kimi-k2.7-code` など）と翻訳専用（`indictrans2`）: 日本語の文面づくりに向かない
 * - 考えた過程を書き出す推論モデル（`qwq-32b`・`deepseek-r1-distill` など）: 短い文言や2行のテロップを
 *   作らせると、思考の文が混ざって長さの検分（side-super.ts・ai-chat.ts）に落ちる
 *
 * 並び順は画面の選択欄に出る順で、軽いものから大きいものへ並べる。
 */
export const WORKERS_AI_MODELS: readonly LlmModelOption[] = [
  { id: '@cf/meta/llama-3.2-3b-instruct', name: 'Llama 3.2 3B Instruct' },
  { id: '@cf/ibm-granite/granite-4.0-h-micro', name: 'Granite 4.0 H Micro' },
  { id: '@cf/meta/llama-3.1-8b-instruct-fp8', name: 'Llama 3.1 8B Instruct（fp8）' },
  { id: '@cf/openai/gpt-oss-20b', name: 'GPT-OSS 20B' },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', name: 'Mistral Small 3.1 24B Instruct' },
  { id: '@cf/google/gemma-4-26b-a4b-it', name: 'Gemma 4 26B' },
  { id: '@cf/qwen/qwen3.8-27b', name: 'Qwen 3.8 27B' },
  { id: '@cf/zai-org/glm-4.7-flash', name: 'GLM-4.7 Flash' },
  { id: '@cf/qwen/qwen3-30b-a3b-fp8', name: 'Qwen3 30B A3B（fp8）' },
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B Instruct' },
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 3.3 70B Instruct（fp8・高速）' },
  { id: '@cf/openai/gpt-oss-120b', name: 'GPT-OSS 120B' },
]

/** 一覧を取るのに必要なもの。fetch・KV・現在時刻は引数で受け取り、テストでは差し替える */
export interface LlmModelsOptions {
  fetch: typeof fetch
  store: KeyValueStore
  /** 現在時刻（ミリ秒）。KVに貯めた一覧が古いかどうかの判定に使う */
  now: number
}

/** KVに貯める形 */
interface CacheEntry {
  readonly expiresAt: number
  readonly models: readonly LlmModelOption[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * KVに貯めた一覧を読む。
 * 壊れている・古い形のものは「貯まっていない」として扱い、取り直して上書きできるようにする
 * （chat-routes.ts の readCache と同じ考え方）。
 */
const readCache = (stored: string | null): CacheEntry | undefined => {
  if (stored === null) return undefined
  try {
    const parsed: unknown = JSON.parse(stored)
    return isRecord(parsed) && typeof parsed.expiresAt === 'number' && Array.isArray(parsed.models) ? (parsed as unknown as CacheEntry) : undefined
  } catch {
    return undefined
  }
}

/** OpenRouter の応答から、文章を返すモデルだけを取り出して名前順に並べる */
const readOpenRouterModels = (body: unknown): readonly LlmModelOption[] => {
  if (!isRecord(body) || !Array.isArray(body.data)) throw new Error('OpenRouter のモデルの一覧を読めません（data が見つかりません）')
  const models = body.data.flatMap((entry: unknown): LlmModelOption[] => {
    if (!isRecord(entry) || typeof entry.id !== 'string') return []
    // 画像だけを返すモデルは文面づくりに使えないので外す。項目が無いものは文章を返すものとして扱う
    const outputs = isRecord(entry.architecture) ? entry.architecture.output_modalities : undefined
    if (Array.isArray(outputs) && !outputs.includes('text')) return []
    return [{ id: entry.id, name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id }]
  })
  if (models.length === 0) throw new Error('OpenRouter のモデルの一覧に、文章を返すモデルが1件もありませんでした')
  return [...models].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * OpenRouter のモデルの一覧を取る。KVに貯めたものが1時間以内なら、それを使う。
 *
 * @throws Error OpenRouter が失敗を返した、応答の形が違う場合
 */
const listOpenRouterModels = async ({ fetch: fetchImpl, store, now }: LlmModelsOptions): Promise<readonly LlmModelOption[]> => {
  const cached = readCache(await store.get(CACHE_KEY))
  if (cached !== undefined && cached.expiresAt > now) return cached.models

  const response = await fetchImpl(OPENROUTER_MODELS_URL)
  if (!response.ok) throw new Error(`OpenRouter のモデルの一覧を取れませんでした（${response.status}）`)
  const models = readOpenRouterModels(await response.json())

  const entry: CacheEntry = { expiresAt: now + CACHE_TTL_MS, models }
  await store.put(CACHE_KEY, JSON.stringify(entry))
  return models
}

/**
 * 提供元ごとに、選べるモデルの一覧を返す。
 *
 * @throws Error OpenRouter から一覧を取れなかった場合（Workers AI では失敗しない）
 */
export const listLlmModels = (provider: LlmProvider, options: LlmModelsOptions): Promise<readonly LlmModelOption[]> =>
  provider === 'openrouter' ? listOpenRouterModels(options) : Promise.resolve(WORKERS_AI_MODELS)
