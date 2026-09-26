/**
 * LLMの設定の読み書き（Workerの呼び出し）
 *
 * どの提供元（Cloudflare の Workers AI・OpenRouter）のどのモデルに文面を作らせるかは Worker
 * （KVの llm-settings）が持ち、管理画面（/llm/ のページ）が配信者のセッションで /api/admin/llm を読み書きする。
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、応答の型はここで定義して形を確かめる。
 * 想定した形でなければエラーにする（Fail-Fast）。黙って既定（Workers AI）に倒すと、OpenRouter を選んだつもりの
 * 配信者が、画面では Workers AI が選ばれているのを見ることになる。
 * 注意: 値（モデル名の長さなど）の検証は Worker（worker/llm-config.ts）だけが持つ。画面とWorkerで二重に持たない。
 * 注意: OpenRouter のAPIキーは設定ではなくWorkerのシークレットなので、読むときに「設定されているか」だけを受け取り、
 * 保存では送らない。
 */
import { createCaller, isRecord } from '../core/api'

const ADMIN_PATH = '/api/admin/llm'

/** 呼び先。worker/llm-config.ts の LLM_PROVIDERS と合わせる */
export const LLM_PROVIDERS = ['workers-ai', 'openrouter'] as const

/** 文面を作らせる用途。worker/llm-config.ts の LLM_PURPOSES と合わせる */
export const LLM_PURPOSES = ['chat', 'summary'] as const

export type LlmProvider = (typeof LLM_PROVIDERS)[number]
export type LlmPurpose = (typeof LLM_PURPOSES)[number]

/** 用途ごとのモデル名 */
export type LlmModels = Record<LlmPurpose, string>

/** LLMの設定。項目は worker/llm-config.ts と合わせる */
export interface LlmSettings {
  /** いま使う提供元 */
  provider: LlmProvider
  /** Workers AI を使うときのモデル名 */
  workersAi: LlmModels
  /** OpenRouter を使うときのモデル名 */
  openrouter: LlmModels
}

/** 読み出しの結果。鍵の有無は設定ではなくWorkerの状態なので、設定とは分けて持つ */
export interface LlmState {
  settings: LlmSettings
  /** OpenRouter のAPIキー（WorkerのシークレットOPENROUTER_API_KEY）が設定されているか */
  apiKeyConfigured: boolean
}

/** 用途ごとのモデル名として読む。足りなければ null */
const readModels = (value: unknown): LlmModels | null => {
  if (!isRecord(value)) return null
  const models = LLM_PURPOSES.map((purpose): [LlmPurpose, unknown] => [purpose, value[purpose]])
  if (!models.every(([, model]) => typeof model === 'string')) return null
  return Object.fromEntries(models) as LlmModels
}

/** LLMの設定として読む。想定した形でなければエラーにする */
const readLlmSettings = (body: unknown, path: string): LlmSettings => {
  const workersAi = isRecord(body) ? readModels(body.workersAi) : null
  const openrouter = isRecord(body) ? readModels(body.openrouter) : null
  if (!isRecord(body) || !LLM_PROVIDERS.includes(body.provider as LlmProvider) || workersAi === null || openrouter === null) {
    throw new Error(`Workerの ${path} の応答が想定した形ではありません`)
  }
  return { provider: body.provider as LlmProvider, workersAi, openrouter }
}

/** 管理画面からの読み書き */
export interface LlmApi {
  /** 保存済みの設定と、鍵が設定されているかを読む。未保存なら既定の設定が返る */
  load(): Promise<LlmState>
  /** 設定をまるごと置き換えて保存する。検証はWorkerが行う */
  save(settings: LlmSettings): Promise<LlmSettings>
}

/**
 * 管理画面からの読み書きを組み立てる。
 *
 * セッションのクッキーと Origin ヘッダーはブラウザが付けるので、ここでは何もしない。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 */
export const createLlmApi = (fetchImpl: typeof fetch): LlmApi => {
  const call = createCaller(fetchImpl)

  return {
    load: async () => {
      const body = await call(ADMIN_PATH)
      return {
        settings: readLlmSettings(body, ADMIN_PATH),
        apiKeyConfigured: isRecord(body) && body.apiKeyConfigured === true,
      }
    },

    save: async (settings) =>
      readLlmSettings(
        await call(ADMIN_PATH, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings),
        }),
        ADMIN_PATH,
      ),
  }
}
