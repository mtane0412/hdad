/**
 * LLMの使用状況のまとめ
 *
 * Workerは日ごとの行（日 × 箇所 × 提供元 × モデル）をそのまま返すので、画面に出す「今日」「直近7日」の
 * まとめはここで作る（ダッシュボードの集計を src/stats/summary.ts に分けてあるのと同じ形）。
 *
 * 注意: 日の区切りはUTCで数える。Workers AI の無料枠がUTCの日で切り替わるので、配信者の時間帯（JST）で
 * 区切ると「今日はどれだけ使ったか」が無料枠の区切りとずれる（画面にもUTCで数えていることを書く）。
 * 注意: 提供元・モデルが違う行も、箇所ごとに足し合わせる。日の途中でモデルを変えても、その箇所の合計は読める。
 * 注意: 知らない箇所（Workerに箇所が増えたとき・やめた箇所の過去の行）は箇所ごとには並べないが、全体の合計には含める。
 * 並べるのは画面が知っている箇所（LLM の5か所と Jev の箇所）だけにし、合計は実際に使った実費と合うようにする。
 * 注意: 判定用のモデル Jev の呼び出し（worker/jev.ts）も同じ表に記録されるので、箇所ごとにまとめて全体の合計に含める。
 * 注意: 日ごとの行の型（LlmUsageDay）は、Workerの応答を読む api.ts が持つものをそのまま使う（同じ形を二重に書かない）。
 * まとめだけを使う側のために、ここからも再び出しておく。
 * 注意: グラフ用の日ごとの数（dailyLlmCalls）は、記録の無い日も 0 として埋める。抜けたままにすると、
 * 呼ばなかった日が横軸から消え、使い方の偏りを読み違える。
 */
import { JEV_USAGES, LLM_USAGES, type JevUsage, type LlmUsage, type LlmUsageDay } from './api'

export type { LlmUsageDay }

/** 直近としてまとめる日数（今日を含む） */
const WEEK_DAYS = 7

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
  /** Jev を使う箇所ごとのまとめ */
  jevUsages: Record<JevUsage, LlmUsagePeriods>
  /** LLM と Jev のすべての箇所を合わせた合計（実費の合計を1か所で読めるようにするため） */
  total: LlmUsagePeriods
}

/** 1日をミリ秒で表した長さ */
const DAY_MS = 24 * 60 * 60 * 1000

const EMPTY_TOTAL = (): LlmUsageTotals => ({ calls: 0, failures: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 })

/** ミリ秒をUTCの日（YYYY-MM-DD）にする */
const toUtcDay = (milliseconds: number): string => new Date(milliseconds).toISOString().slice(0, 10)

/** 行を合計へ足し込む */
const addUsage = (totals: LlmUsageTotals, row: LlmUsageDay): void => {
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
  const today = toUtcDay(now)
  const recentStart = toUtcDay(now - (WEEK_DAYS - 1) * DAY_MS)

  const usages = Object.fromEntries(LLM_USAGES.map((usage) => [usage, { today: EMPTY_TOTAL(), week: EMPTY_TOTAL() }])) as Record<LlmUsage, LlmUsagePeriods>
  const jevUsages = Object.fromEntries(JEV_USAGES.map((usage) => [usage, { today: EMPTY_TOTAL(), week: EMPTY_TOTAL() }])) as Record<JevUsage, LlmUsagePeriods>
  const total: LlmUsagePeriods = { today: EMPTY_TOTAL(), week: EMPTY_TOTAL() }
  // 箇所の名前は LLM と Jev で重ならないので、1つの表として引ける
  const byUsage: Readonly<Record<string, LlmUsagePeriods | undefined>> = { ...usages, ...jevUsages }

  for (const row of days) {
    if (row.day < recentStart) continue
    // 画面が知らない箇所の行も、全体の合計には足す（実費の合計が請求額と食い違わないようにする）
    addUsage(total.week, row)
    if (row.day === today) addUsage(total.today, row)
    // 箇所ごとには、並べる欄のある箇所だけを足す
    const periods = byUsage[row.usage]
    if (periods === undefined) continue
    addUsage(periods.week, row)
    if (row.day === today) addUsage(periods.today, row)
  }

  return { usages, jevUsages, total }
}

/** グラフに渡す1日ぶんの数 */
export interface LlmDailyCalls {
  /** UTCの日（YYYY-MM-DD） */
  day: string
  /** すべての箇所を合わせた、文面を受け取れた回数 */
  calls: number
  /** すべての箇所を合わせた、失敗した回数 */
  failures: number
}

/**
 * 日ごとの行を、すべての箇所を合わせた1日ごとの回数にする（使用状況のグラフ用）。
 *
 * @param days Workerから受け取った日ごとの行（順番は問わない）
 * @param now 現在時刻（ミリ秒）。UTCの今日を決めるのに使う
 * @param windowDays 今日を含めて並べる日数
 * @returns 古い順に windowDays 件。記録の無い日も 0 として含める
 */
export const dailyLlmCalls = (days: readonly LlmUsageDay[], now: number, windowDays: number): LlmDailyCalls[] => {
  const series = Array.from({ length: windowDays }, (_, index) => ({
    day: toUtcDay(now - (windowDays - 1 - index) * DAY_MS),
    calls: 0,
    failures: 0,
  }))
  const byDay = new Map(series.map((entry) => [entry.day, entry]))
  for (const row of days) {
    const entry = byDay.get(row.day)
    if (entry === undefined) continue
    entry.calls += row.calls
    entry.failures += row.failures
  }
  return series
}
