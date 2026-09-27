/**
 * LLMの使用状況のまとめ
 *
 * Workerは日ごとの行（日 × 箇所 × 提供元 × モデル）をそのまま返すので、画面に出す「今日」「直近7日」の
 * まとめはここで作る（ダッシュボードの集計を src/stats/summary.ts に分けてあるのと同じ形）。
 *
 * 注意: 日の区切りはUTCで数える。Workers AI の無料枠がUTCの日で切り替わるので、配信者の時間帯（JST）で
 * 区切ると「今日はどれだけ使ったか」が無料枠の区切りとずれる（画面にもUTCで数えていることを書く）。
 * 注意: 提供元・モデルが違う行も、箇所ごとに足し合わせる。日の途中でモデルを変えても、その箇所の合計は読める。
 * 注意: 知らない箇所（Workerに箇所が増えたとき）の行は無視する。画面が知っている4か所だけを並べる。
 */
import { LLM_USAGES, type LlmUsage } from './api'

/** 直近としてまとめる日数（今日を含む） */
const WEEK_DAYS = 7

/** Workerが返す日ごとの1行。worker/llm-usage-store.ts の LlmUsageRow と合わせる */
export interface LlmUsageDay {
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

/** 足し合わせた数 */
export interface LlmUsageTotals {
  /** 文面を受け取れた回数 */
  calls: number
  /** 失敗した回数 */
  failures: number
  promptTokens: number
  completionTokens: number
  /** 提供元が返した実費（米ドル）の合計。Workers AI は返さないので 0 のまま */
  costUsd: number
}

/** 1か所ぶんのまとめ */
export interface LlmUsagePeriods {
  today: LlmUsageTotals
  week: LlmUsageTotals
}

/** 画面に出すまとめ */
export interface LlmUsageSummary {
  usages: Record<LlmUsage, LlmUsagePeriods>
  /** 4か所を合わせた合計（実費の合計を1か所で読めるようにするため） */
  total: LlmUsagePeriods
}

const 空の合計 = (): LlmUsageTotals => ({ calls: 0, failures: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 })

/** ミリ秒をUTCの日（YYYY-MM-DD）にする */
const toUtcDay = (milliseconds: number): string => new Date(milliseconds).toISOString().slice(0, 10)

/** 行を合計へ足し込む */
const 足す = (totals: LlmUsageTotals, row: LlmUsageDay): void => {
  totals.calls += row.calls
  totals.failures += row.failures
  totals.promptTokens += row.promptTokens
  totals.completionTokens += row.completionTokens
  totals.costUsd += row.costUsd
}

/**
 * 日ごとの行を、箇所ごとの「今日」「直近7日」にまとめる。
 *
 * @param days Workerから受け取った日ごとの行（順番は問わない）
 * @param now 現在時刻（ミリ秒）。UTCの今日を決めるのに使う
 */
export const summarizeLlmUsage = (days: readonly LlmUsageDay[], now: number): LlmUsageSummary => {
  const 今日 = toUtcDay(now)
  const 直近の始まり = toUtcDay(now - (WEEK_DAYS - 1) * 24 * 60 * 60 * 1000)

  const usages = Object.fromEntries(LLM_USAGES.map((usage) => [usage, { today: 空の合計(), week: 空の合計() }])) as Record<LlmUsage, LlmUsagePeriods>
  const total: LlmUsagePeriods = { today: 空の合計(), week: 空の合計() }

  for (const row of days) {
    const periods = usages[row.usage as LlmUsage]
    // 画面が知らない箇所の行は数えない（Workerに箇所が増えても、並べる欄が無いため）
    if (periods === undefined || row.day < 直近の始まり) continue
    足す(periods.week, row)
    足す(total.week, row)
    if (row.day === 今日) {
      足す(periods.today, row)
      足す(total.today, row)
    }
  }

  return { usages, total }
}
