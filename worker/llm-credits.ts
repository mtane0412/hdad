/**
 * OpenRouter の残高
 *
 * 管理画面（/llm/）の使用状況に「いくら付与されていて、いくら使ったか」を出すために、OpenRouter の
 * APIへ問い合わせる（https://openrouter.ai/api/v1/credits）。Workerのシークレット（OPENROUTER_API_KEY）で
 * 読めるので、このためにアカウント単位の鍵を増やす必要はない。
 *
 * 注意: Workers AI（Cloudflare）には対応するものが無い。Neurons の消費量は GraphQL の分析APIにあり、
 * アカウント単位のAPIトークンを要求するので、このWorkerは持たない方針である（llm-models.ts が
 * モデルの一覧を手で持つのと同じ理由）。Workers AI の使い具合は、自前で数えた呼び出しの回数
 * （llm-usage-store.ts）から推し量る。
 * 注意: KVに貯めない。読むのは配信者が管理画面を開いたときだけなので問い合わせは増えず、貯めると
 * 課金した直後に古い残高を見せることになる（モデルの一覧を1時間貯めるのは、一覧が日ごとしか変わらないため）。
 * 注意: 取れなかったときは 0 を返さずに投げる（Fail-Fast）。残高が 0 に見えると、配信者は課金し直すか
 * どうかの判断を誤る。
 */

/** OpenRouter の残高の問い合わせ先 */
const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/api/v1/credits'

/** 問い合わせに必要なもの。通信はテストで差し替えられるよう引数で受け取る */
export interface LlmCreditsOptions {
  fetch: typeof fetch
  /** OpenRouter のAPIキー（Workerのシークレット OPENROUTER_API_KEY） */
  apiKey: string
}

/** OpenRouter の残高（米ドル） */
export interface LlmCredits {
  /** これまでに付与された額 */
  readonly totalCredits: number
  /** これまでに使った額 */
  readonly totalUsage: number
  /** 残り（付与額 − 使用額）。画面で引き算させず、ここで出しておく */
  readonly remaining: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * OpenRouter の残高を読む。
 *
 * @throws Error OpenRouter が失敗を返した、応答の形が違う場合
 */
export const readOpenRouterCredits = async ({ fetch: fetchImpl, apiKey }: LlmCreditsOptions): Promise<LlmCredits> => {
  const response = await fetchImpl(OPENROUTER_CREDITS_URL, { headers: { Authorization: `Bearer ${apiKey}` } })
  if (!response.ok) throw new Error(`OpenRouter の残高を取れませんでした（${response.status}）`)

  const body: unknown = await response.json()
  const data = isRecord(body) ? body.data : undefined
  if (!isRecord(data) || typeof data.total_credits !== 'number' || typeof data.total_usage !== 'number') {
    throw new Error('OpenRouter の残高を読めません（total_credits と total_usage が見つかりません）')
  }
  return { totalCredits: data.total_credits, totalUsage: data.total_usage, remaining: data.total_credits - data.total_usage }
}
