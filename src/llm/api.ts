/**
 * LLMの設定の読み書き（Workerの呼び出し）
 *
 * AIを使う5か所（字幕の翻訳・トリガーの動作 aiChat・サイドスーパー・視聴者の人物像・配信のあらすじ）それぞれについて、
 * どの提供元（Cloudflare の Workers AI・OpenRouter）のどのモデルに作らせるかは Worker（KVの llm-settings）が持ち、
 * 管理画面（/llm/ のページ）が配信者のセッションで /api/admin/llm を読み書きする。
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、応答の型はここで定義して形を確かめる。
 * 想定した形でなければエラーにする（Fail-Fast）。黙って既定（Workers AI）に倒すと、OpenRouter を選んだつもりの
 * 配信者が、画面では Workers AI が選ばれているのを見ることになる。
 * 注意: 値（モデル名の長さなど）の検証は Worker（worker/llm-config.ts）だけが持つ。画面とWorkerで二重に持たない。
 * 注意: OpenRouter のAPIキーは設定ではなくWorkerのシークレットなので、読むときに「設定されているか」だけを受け取り、
 * 保存では送らない。
 * 注意: 使用状況（どれだけLLMを呼んだか）と OpenRouter の残高は、設定とは別の経路で読む。出どころが違い
 * （使用状況は自前で数えたD1の記録、残高は OpenRouter への問い合わせ）、片方を読めなかったことをもう片方に
 * 波及させないためである（モデルの一覧を提供元ごとに分けて読むのと同じ考え方）。
 * 同じページに置く「字幕の翻訳」の区画（translation-card.tsx）が、翻訳の提供元の設定（/api/admin/translation）と
 * DeepL の今月の使用量（/api/admin/translation/deepl-usage）もここから読み書きする（issue #191）。
 * 注意: 使用状況・残高も、応答が想定した形でなければエラーにする。数えられていないことを 0 として見せると、
 * 配信者は「まだ使っていない」と取り違える。
 */
import { createCaller, isRecord } from '../core/api'

const ADMIN_PATH = '/api/admin/llm'
const MODELS_PATH = '/api/admin/llm/models'
const USAGE_PATH = '/api/admin/llm/usage'
const CREDITS_PATH = '/api/admin/llm/credits'
const TRANSLATION_PATH = '/api/admin/translation'
const DEEPL_USAGE_PATH = '/api/admin/translation/deepl-usage'

/** 呼び先。worker/llm-config.ts の LLM_PROVIDERS と合わせる */
export const LLM_PROVIDERS = ['workers-ai', 'openrouter'] as const

/** LLMに文面を作らせる箇所。並び順も worker/llm-config.ts の LLM_USAGES と合わせる（画面に出す順になる） */
export const LLM_USAGES = [
  'translation',
  'aiChat',
  'sideSuper',
  'viewerSummary',
  'streamSummary',
  'streamTitle',
  'townTour',
  'townBond',
  'autoText',
  'opinionSort',
  'opinionPrompt',
] as const

/** 字幕の翻訳の提供元。worker/translation-config.ts の TRANSLATION_PROVIDERS と合わせる（画面の選択欄に出す順になる） */
export const TRANSLATION_PROVIDERS = ['off', 'llm', 'm2m100', 'deepl'] as const

export type TranslationProvider = (typeof TRANSLATION_PROVIDERS)[number]

/** 字幕の翻訳の設定の読み出しの結果。鍵の有無は設定ではなくWorkerの状態なので、設定とは分けて持つ */
export interface TranslationState {
  provider: TranslationProvider
  /** DeepL のAPIキー（WorkerのシークレットDEEPL_API_KEY）が設定されているか */
  deeplKeyConfigured: boolean
}

/** DeepL の今月の使用量。worker/translation.ts の DeeplUsage と合わせる */
export interface DeeplUsage {
  /** 今月訳した文字数 */
  characterCount: number
  /** 今月訳せる文字数の上限 */
  characterLimit: number
}

/**
 * 判定用のモデル Jev を使う箇所。worker/jev.ts の JEV_USAGES と合わせる。
 *
 * Jev はモデルを選ばせない（worker/jev.ts が版を固定している）ので、設定には含まれず、使用状況にだけ並ぶ。
 */
export const JEV_USAGES = ['bgm', 'streamTitle', 'opinionFilter'] as const

export type LlmProvider = (typeof LLM_PROVIDERS)[number]
export type LlmUsage = (typeof LLM_USAGES)[number]
export type JevUsage = (typeof JEV_USAGES)[number]

/** 提供元ごとのモデル名 */
export type LlmModels = Record<LlmProvider, string>

/** 1か所ぶんの設定 */
export interface LlmUsageSettings {
  /** いま使う提供元 */
  provider: LlmProvider
  /** 提供元ごとのモデル名。選んでいないほうも覚えておく */
  models: LlmModels
}

/** LLMの設定。項目は worker/llm-config.ts と合わせる */
export interface LlmSettings {
  usages: Record<LlmUsage, LlmUsageSettings>
}

/** モデルの選択欄に出す1件。worker/llm-models.ts の LlmModelOption と合わせる */
export interface LlmModelOption {
  /** 設定に保存するモデル名 */
  id: string
  /** 画面に出す名前 */
  name: string
}

/** 使用状況の1行（日 × 箇所 × 提供元 × モデル）。worker/llm-usage-store.ts の LlmUsageRow と合わせる */
export interface LlmUsageDay {
  day: string
  usage: string
  provider: string
  model: string
  /** 文面を受け取れた回数 */
  calls: number
  /** 失敗した回数 */
  failures: number
  promptTokens: number
  completionTokens: number
  /** 提供元が返した実費（米ドル）。Workers AI は返さないので 0 */
  costUsd: number
}

/** OpenRouter の残高（米ドル）。worker/llm-credits.ts の LlmCredits と合わせる */
export interface LlmCredits {
  totalCredits: number
  totalUsage: number
  remaining: number
}

/** 読み出しの結果。鍵の有無は設定ではなくWorkerの状態なので、設定とは分けて持つ */
export interface LlmState {
  settings: LlmSettings
  /** OpenRouter のAPIキー（WorkerのシークレットOPENROUTER_API_KEY）が設定されているか */
  apiKeyConfigured: boolean
}

/** 提供元ごとのモデル名として読む。足りなければ null */
const readModels = (value: unknown): LlmModels | null => {
  if (!isRecord(value)) return null
  const models = LLM_PROVIDERS.map((provider): [LlmProvider, unknown] => [provider, value[provider]])
  if (!models.every(([, model]) => typeof model === 'string')) return null
  return Object.fromEntries(models) as LlmModels
}

/** 1か所ぶんの設定として読む。足りなければ null */
const readUsage = (value: unknown): LlmUsageSettings | null => {
  if (!isRecord(value) || !LLM_PROVIDERS.includes(value.provider as LlmProvider)) return null
  const models = readModels(value.models)
  return models === null ? null : { provider: value.provider as LlmProvider, models }
}

/** LLMの設定として読む。想定した形でなければエラーにする */
const readLlmSettings = (body: unknown, path: string): LlmSettings => {
  const given = isRecord(body) && isRecord(body.usages) ? body.usages : null
  const usages = given === null ? null : LLM_USAGES.map((usage): [LlmUsage, LlmUsageSettings | null] => [usage, readUsage(given[usage])])
  if (usages === null || usages.some(([, settings]) => settings === null)) {
    throw new Error(`Workerの ${path} の応答が想定した形ではありません`)
  }
  return { usages: Object.fromEntries(usages) as Record<LlmUsage, LlmUsageSettings> }
}

/** モデルの一覧として読む。空、または想定した形でなければエラーにする */
const readModelOptions = (body: unknown, path: string): LlmModelOption[] => {
  const models = isRecord(body) && Array.isArray(body.models) ? body.models : null
  if (models === null || models.length === 0 || !models.every((model: unknown) => isRecord(model) && typeof model.id === 'string' && typeof model.name === 'string')) {
    throw new Error(`Workerの ${path} の応答が想定した形ではありません`)
  }
  return models as LlmModelOption[]
}

/** 使用状況として読む。数の項目が1つでも欠けていればエラーにする */
const readUsageDays = (body: unknown, path: string): LlmUsageDay[] => {
  const days = isRecord(body) && Array.isArray(body.days) ? body.days : null
  const numericField = ['calls', 'failures', 'promptTokens', 'completionTokens', 'costUsd'] as const
  const validShape = (row: unknown): boolean =>
    isRecord(row) &&
    ['day', 'usage', 'provider', 'model'].every((key) => typeof row[key] === 'string') &&
    numericField.every((key) => typeof row[key] === 'number')
  if (days === null || !days.every(validShape)) throw new Error(`Workerの ${path} の応答が想定した形ではありません`)
  return days as LlmUsageDay[]
}

/** 残高として読む。足りなければエラーにする */
const readCredits = (body: unknown, path: string): LlmCredits => {
  const field = ['totalCredits', 'totalUsage', 'remaining'] as const
  if (!isRecord(body) || !field.every((key) => typeof body[key] === 'number')) {
    throw new Error(`Workerの ${path} の応答が想定した形ではありません`)
  }
  return body as unknown as LlmCredits
}

/** 字幕の翻訳の提供元として読む。知らない名前ならエラーにする（黙って「訳さない」に倒さない） */
const readTranslationProvider = (value: unknown, path: string): TranslationProvider => {
  const found = TRANSLATION_PROVIDERS.find((provider) => provider === value)
  if (found === undefined) throw new Error(`Workerの ${path} の応答が想定した形ではありません`)
  return found
}

/** DeepL の使用量として読む。足りなければエラーにする */
const readDeeplUsage = (body: unknown, path: string): DeeplUsage => {
  if (!isRecord(body) || typeof body.characterCount !== 'number' || typeof body.characterLimit !== 'number') {
    throw new Error(`Workerの ${path} の応答が想定した形ではありません`)
  }
  return { characterCount: body.characterCount, characterLimit: body.characterLimit }
}

/** 管理画面からの読み書き */
export interface LlmApi {
  /** 保存済みの設定と、鍵が設定されているかを読む。未保存なら既定の設定が返る */
  load(): Promise<LlmState>
  /** 設定をまるごと置き換えて保存する。検証はWorkerが行う */
  save(settings: LlmSettings): Promise<LlmSettings>
  /**
   * その提供元で選べるモデルの一覧を読む（画面の選択欄に出す候補）。
   *
   * 提供元ごとに分けて読むのは、使っていない提供元の一覧を取りに行かずに済ませるためと、
   * 片方を取れなかったことをもう片方の選択欄に波及させないためである。
   */
  listModels(provider: LlmProvider): Promise<LlmModelOption[]>
  /**
   * LLMを呼んだ回数・トークン数・実費の、日ごとのまとめを読む（直近1か月ぶん）。
   *
   * 「今日」「直近7日」へのまとめ方は usage.ts が持つ（Workerは日ごとの行をそのまま返す）。
   */
  loadUsage(): Promise<LlmUsageDay[]>
  /**
   * OpenRouter の残高を読む。
   *
   * 鍵が無ければWorkerが断る（ApiError）ので、呼ぶのは鍵が設定されているときだけにする。
   * Workers AI（Cloudflare）には対応するものが無い（残量を読むにはアカウント単位の鍵が要るため）。
   */
  loadCredits(): Promise<LlmCredits>
  /** 字幕の翻訳の提供元と、DeepL の鍵が設定されているかを読む。未保存なら「訳さない」が返る */
  loadTranslation(): Promise<TranslationState>
  /** 字幕の翻訳の提供元を保存する。検証はWorkerが行う */
  saveTranslation(provider: TranslationProvider): Promise<TranslationProvider>
  /**
   * DeepL の今月の使用量を読む。
   *
   * 鍵が無ければWorkerが断る（ApiError）ので、呼ぶのは鍵が設定されているときだけにする。
   */
  loadDeeplUsage(): Promise<DeeplUsage>
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

    listModels: async (provider) => {
      const path = `${MODELS_PATH}?provider=${encodeURIComponent(provider)}`
      return readModelOptions(await call(path), MODELS_PATH)
    },

    loadUsage: async () => readUsageDays(await call(USAGE_PATH), USAGE_PATH),

    loadCredits: async () => readCredits(await call(CREDITS_PATH), CREDITS_PATH),

    loadTranslation: async () => {
      const body = await call(TRANSLATION_PATH)
      return {
        provider: readTranslationProvider(isRecord(body) ? body.provider : undefined, TRANSLATION_PATH),
        deeplKeyConfigured: isRecord(body) && body.deeplKeyConfigured === true,
      }
    },

    saveTranslation: async (provider) => {
      const body = await call(TRANSLATION_PATH, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      })
      return readTranslationProvider(isRecord(body) ? body.provider : undefined, TRANSLATION_PATH)
    },

    loadDeeplUsage: async () => readDeeplUsage(await call(DEEPL_USAGE_PATH), DEEPL_USAGE_PATH),
  }
}
