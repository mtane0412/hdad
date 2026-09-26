/**
 * LLMの呼び出し
 *
 * 文面づくり（ai-chat.ts）・サイドスーパー（side-super.ts）・人物像（viewer-summary.ts）・あらすじ（stream-summary.ts）から
 * 呼ばれる、LLMへの唯一の入口である。呼び出し側は「どこで使うか」（LlmUsage）だけを指名し、どの提供元
 * （Cloudflare の Workers AI・OpenRouter）のどのモデルを使うかは、保存された設定（llm-config.ts）が決める。
 * 提供元を増やしても、材料を組み立てる側を書き換えずに済む形にしてある。
 *
 * 提供元は箇所ごとに選べるので、1回の cron の中で Workers AI と OpenRouter の両方を呼ぶこともある
 * （あらすじだけ賢いモデルに任せ、発言ごとに呼ばれるチャットの文面は無料枠に留める、といった使い分け）。
 *
 * 注意: モデルによって応答の形が違う（従来のモデルは response、新しいモデルと OpenRouter は OpenAI互換の choices）。
 * 読み分け（readResponse）はここ1か所に持ち、呼び出し側が場合分けを持たずに済むようにする。
 * 注意: 設定（KV）の読み出しは1回だけにして覚えておく。チャットの発言のたびに通る道なので、
 * 余分な読み出しを増やさない（alert-state.ts の「要らなければ読まない」と同じ考え方で、一度も呼ばれなければ読まない）。
 * 注意: 失敗は黙って別の提供元へ落とさずに投げる（Fail-Fast）。呼び出し側が失敗として記録するので、
 * 配信者が「鍵が無い」「残高が足りない」といった理由に気づける。
 * 注意: OpenRouter へは推論を切って送る（reasoning.enabled を偽にする）。このツールが送る上限は箇所ごとに
 * 100〜400トークンと小さく、推論モデルではそれを思考トークンが使い切って content が null のまま
 * finish_reason が length で返るためである（実際に openai/gpt-6-luna をあらすじに選んだ配信で、
 * 5分おきの収集がすべてこれで失敗した）。
 */
import { loadLlmSettings, type LlmSettings, type LlmUsage } from './llm-config'
import type { KeyValueStore } from './store'

/** OpenRouter のチャット補完（OpenAI互換） */
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

/** 失敗の文面に載せる応答本文の長さ。理由が読める程度にとどめ、長い応答をそのまま記録に流さない */
const MAX_ERROR_BODY_LENGTH = 200

/** LLMへ渡す1つの発言 */
export interface LlmMessage {
  readonly role: 'system' | 'user'
  readonly content: string
}

/** LLMへの注文 */
export interface LlmRequest {
  readonly messages: readonly LlmMessage[]
  /** 作らせる文面の長さの上限（トークン）。箇所ごとに呼び出し側が決める */
  readonly maxTokens: number
}

/**
 * 使う箇所を指名して文面を1つ作らせるもの。
 *
 * KV・R2・D1 と同じく、テストでは代役に差し替える（worker/fake-ai.ts）。
 */
export interface TextGenerator {
  /** @throws Error LLMが失敗した（無料枠切れ・残高不足を含む）、応答の形が違う場合 */
  run(usage: LlmUsage, request: LlmRequest): Promise<string>
}

/**
 * Cloudflare の Workers AI のバインディング（Env.AI）のうち、このファイルが使う部分だけを写した型。
 *
 * Cloudflareの型をそのまま使わずに最小の形で受け取り、テストでは代役に差し替える。
 */
export interface WorkersAi {
  run(model: string, input: Record<string, unknown>): Promise<unknown>
}

/** OpenAI互換の応答（choices）から文面を取り出す。読めなければ null */
const readChoice = (result: Record<string, unknown>): string | null => {
  const choices = result.choices
  if (!Array.isArray(choices)) return null
  const first: unknown = choices[0]
  if (typeof first !== 'object' || first === null || !('message' in first)) return null
  const message = (first as { message: unknown }).message
  if (typeof message !== 'object' || message === null || !('content' in message)) return null
  const content = (message as { content: unknown }).content
  return typeof content === 'string' ? content : null
}

/**
 * 上限（max_tokens）に当たって本文が空のまま返されたかを見る。
 *
 * 推論モデルは答えを書く前に思考トークンを使うので、このツールが送る小さな上限（100〜400）では
 * 思考だけで枠を使い切り、finish_reason が length のまま content が null で返る。
 * 「応答の形が違う」と区別できないと、配信者は原因がモデルの選択にあることに気づけない。
 */
const isCutOffByLimit = (result: Record<string, unknown>): boolean => {
  const choices = result.choices
  if (!Array.isArray(choices)) return false
  const first: unknown = choices[0]
  return typeof first === 'object' && first !== null && 'finish_reason' in first && (first as { finish_reason: unknown }).finish_reason === 'length'
}

/**
 * LLMの応答から文面を取り出す。
 *
 * モデルによって応答の形が違う。llama-3.1-8b のような従来のモデルは response に文面を入れて返すが、
 * llama-3.3-70b のような新しいモデルと OpenRouter は response を持たず、OpenAI互換の choices だけで返す。
 * 読める形を1か所にまとめ、どの提供元・どのモデルを選んでも呼び出し側が場合分けを持たずに済むようにする。
 *
 * @throws Error どちらの形でもなかった場合（黙って空の文面として扱わない）。上限に当たって本文が空だった場合は、
 * 推論モデルを選んでいる可能性を文面に出す
 */
export const readResponse = (result: unknown): string => {
  if (typeof result === 'object' && result !== null) {
    if ('response' in result && typeof result.response === 'string') return result.response
    const content = readChoice(result as Record<string, unknown>)
    if (content !== null) return content
    if (isCutOffByLimit(result as Record<string, unknown>)) {
      throw new Error(
        `LLMが上限（max_tokens）に当たり、本文を返しませんでした。推論モデルを選んでいると、考えている途中で上限に達して本文が空になります。管理画面（/llm/）で推論しないモデルへ変えてください: ${JSON.stringify(result)}`,
      )
    }
  }
  throw new Error(`LLMの応答を読めません（response も choices の文面も見つかりません）: ${JSON.stringify(result)}`)
}

/** Workers AI のバインディングへ送る */
const runWorkersAi = async (ai: WorkersAi, model: string, request: LlmRequest): Promise<string> =>
  readResponse(await ai.run(model, { messages: request.messages, max_tokens: request.maxTokens }))

/**
 * OpenRouter のAPIへ送る。
 *
 * @throws Error 鍵が設定されていない、OpenRouter が失敗を返した場合
 */
const runOpenRouter = async (fetchImpl: typeof fetch, apiKey: string | undefined, model: string, request: LlmRequest): Promise<string> => {
  if (apiKey === undefined || apiKey === '') {
    throw new Error('LLMの提供元に OpenRouter を選んでいますが、WorkerのシークレットOPENROUTER_API_KEYが設定されていません')
  }

  const response = await fetchImpl(OPENROUTER_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    // 推論を切って送る。推論モデルでは思考トークンがこの小さな上限（100〜400）を使い切り、本文が空で返るため。
    // 推論を持たないモデルでは無視される項目なので、モデルによる場合分けは持たない
    body: JSON.stringify({ model, messages: request.messages, max_tokens: request.maxTokens, reasoning: { enabled: false } }),
  })
  if (!response.ok) {
    const body = (await response.text()).slice(0, MAX_ERROR_BODY_LENGTH)
    throw new Error(`OpenRouter が失敗を返しました（${response.status} ${model}）: ${body}`)
  }
  return readResponse(await response.json())
}

/** 組み立てに必要なもの */
export interface LlmOptions {
  /** Cloudflare の Workers AI のバインディング（Env.AI） */
  ai: WorkersAi
  /** 設定（llm-settings）を置いてあるストア（KV） */
  store: KeyValueStore
  /** OpenRouter への通信。テストで差し替えられるよう引数で受け取る */
  fetch: typeof fetch
  /** OpenRouter のAPIキー（Workerのシークレット OPENROUTER_API_KEY）。未設定なら undefined */
  apiKey: string | undefined
}

/**
 * 保存された設定に従ってLLMを呼ぶものを組み立てる。
 *
 * 設定はここでは読まず、最初に run が呼ばれたときに1回だけ読んで覚える
 * （一度もLLMを使わない通知では、KVの読み出しが起きない）。
 */
export const createLlm = ({ ai, store, fetch: fetchImpl, apiKey }: LlmOptions): TextGenerator => {
  let 設定: Promise<LlmSettings> | null = null

  return {
    run: async (usage, request) => {
      設定 ??= loadLlmSettings(store)
      const { provider, models } = (await 設定).usages[usage]
      const model = models[provider]
      return provider === 'openrouter' ? runOpenRouter(fetchImpl, apiKey, model, request) : runWorkersAi(ai, model, request)
    },
  }
}
