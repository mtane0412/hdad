/**
 * LLMの使用状況の読み書き
 *
 * LLMを呼んだ回数・トークン数・実費を「日 × 箇所 × 提供元 × モデル」の1行へ足し込み（llm_usage）、
 * 管理画面（/llm/）のために読み出す。記録するのは worker/llm.ts で、そこがLLMへの唯一の入口なので
 * 4か所（aiChat・sideSuper・viewerSummary・streamSummary）すべてを取りこぼさずに数えられる。
 *
 * 注意: 1回の呼び出しで1行を足さない。チャットの文面（aiChat）は視聴者の発言ごとに呼ばれるため、
 * 1呼び出し1行にすると行が際限なく増える（viewers が「発言ではなく人を貯める」のと同じ考え方）。
 * 注意: 日の区切りは UTC にする。Workers AI の無料枠が UTC の日で切り替わるためで、配信者の時間帯（JST）に
 * 合わせると「今日はどれだけ使ったか」が無料枠の区切りとずれる。
 * 注意: 失敗（無料枠切れ・残高不足・推論モデルで本文が空）も数える。collection_failures には最新の50件しか
 * 残らないので、「今日は何回失敗したか」はここから読む。
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。
 */
import type { Database } from './database'
import type { LlmProvider, LlmUsage } from './llm-config'

/** 記録を残す期間（日）。1回の配信を振り返るだけでなく、月ごとの増減も読める長さにする */
const RETENTION_DAYS = 90

/** LLMを1回呼んだ結果。llm.ts が呼び出しのたびに渡す */
export interface LlmCallRecord {
  /** 使った箇所 */
  readonly usage: LlmUsage
  readonly provider: LlmProvider
  readonly model: string
  /** 提供元が応答に入れてきたトークン数。返してこなければ 0 */
  readonly promptTokens: number
  readonly completionTokens: number
  /** 提供元が応答に入れてきた実費（米ドル）。返してこなければ 0（Workers AI は常に 0） */
  readonly costUsd: number
  /** 失敗した呼び出しか */
  readonly failed: boolean
}

/** 画面に出すための1行（日ごとのまとめ） */
export interface LlmUsageRow {
  day: string
  usage: string
  provider: string
  model: string
  calls: number
  failures: number
  promptTokens: number
  completionTokens: number
  costUsd: number
}

/** ミリ秒を UTC の日（YYYY-MM-DD）にする */
export const toUtcDay = (milliseconds: number): string => new Date(milliseconds).toISOString().slice(0, 10)

/**
 * LLMを1回呼んだ結果を足し込み、保持期間を過ぎた行を消す。
 *
 * 同じ日・同じ箇所・同じ提供元・同じモデルなら行を増やさず、回数とトークン数と実費を足す
 * （recordFailure が「時刻と種類」で1行を持つのと同じ、ON CONFLICT での足し込み）。
 */
export const recordLlmUsage = async (db: Database, record: LlmCallRecord, now: number): Promise<void> => {
  const day = toUtcDay(now)
  const 消す日 = toUtcDay(now - RETENTION_DAYS * 24 * 60 * 60 * 1000)
  await db.batch([
    db
      .prepare(
        `INSERT INTO llm_usage (day, usage, provider, model, calls, failures, prompt_tokens, completion_tokens, cost_usd, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (day, usage, provider, model) DO UPDATE SET
           calls = calls + excluded.calls,
           failures = failures + excluded.failures,
           prompt_tokens = prompt_tokens + excluded.prompt_tokens,
           completion_tokens = completion_tokens + excluded.completion_tokens,
           cost_usd = cost_usd + excluded.cost_usd,
           updated_at = excluded.updated_at`,
      )
      .bind(
        day,
        record.usage,
        record.provider,
        record.model,
        record.failed ? 0 : 1,
        record.failed ? 1 : 0,
        record.promptTokens,
        record.completionTokens,
        record.costUsd,
        new Date(now).toISOString(),
      ),
    db.prepare('DELETE FROM llm_usage WHERE day < ?1').bind(消す日),
  ])
}

/** 指定した日（UTC の YYYY-MM-DD）以降のまとめを、新しい日から順に読む */
export const listLlmUsage = async (db: Database, sinceDay: string): Promise<LlmUsageRow[]> => {
  const { results } = await db
    .prepare(
      `SELECT day, usage, provider, model, calls, failures,
              prompt_tokens AS promptTokens, completion_tokens AS completionTokens, cost_usd AS costUsd
       FROM llm_usage WHERE day >= ?1 ORDER BY day DESC, usage ASC, model ASC`,
    )
    .bind(sinceDay)
    .all<LlmUsageRow>()
  return results
}
