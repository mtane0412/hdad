/**
 * 配信の記録の集計・整形
 *
 * Workerから受け取った記録（api.ts）を、ダッシュボードが出す形に変える。
 * 表示（React）とは切り離してあるので、ここだけをテストできる。
 *
 * 注意: 記録が無いことと 0 は別物として扱う。記録が無い値は null のまま持ち、表示のときに「—」にする（Fail-Fast）。
 * 日時は配信者のブラウザのタイムゾーンで表示する（Date の既定のタイムゾーンに任せる）。
 */
import type { FollowerSample, SessionSummary, ViewerSample } from './api'

/** サブスク（新規）のイベントの種類 */
const SUBSCRIBE = 'channel.subscribe'
/** サブスク（継続の報告）のイベントの種類 */
const SUBSCRIPTION_MESSAGE = 'channel.subscription.message'
/** チャンネルポイント交換のイベントの種類 */
const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
/** レイドのイベントの種類 */
const RAID = 'channel.raid'

const MS_PER_MINUTE = 60 * 1000
const MS_PER_HOUR = 60 * MS_PER_MINUTE
const MS_PER_DAY = 24 * MS_PER_HOUR

/** 切り替えられる期間（日数）。上から順にボタンに並ぶ */
export const PERIOD_DAYS: readonly number[] = [7, 30, 90]

/** 期間の概要。記録が無い値は null */
export interface Overview {
  /** 期間内に始まった配信の回数 */
  streamCount: number
  /** 期間内の配信時間の合計（ミリ秒） */
  totalDurationMs: number
  /** 配信時間で重み付けした平均視聴者数（小数第1位まで） */
  averageViewers: number | null
  peakViewers: number | null
  /** いちばん新しい記録のフォロワー数 */
  followerTotal: number | null
  /** 期間の開始時点からのフォロワー数の増減 */
  followerDelta: number | null
}

/** 配信1回のイベントの件数 */
export interface EventTotals {
  subscriptions: number
  redemptions: number
  raids: number
}

/** グラフに渡す視聴者数の点。at は時刻（ミリ秒） */
export interface ViewerPoint {
  at: number
  viewers: number
}

/** グラフに渡すフォロワー数の点。at は時刻（ミリ秒） */
export interface FollowerPoint {
  at: number
  followers: number
}

/** 期間の開始時刻（ミリ秒） */
const periodStart = (days: number, now: number): number => now - days * MS_PER_DAY

/** 指定した日数の中で始まった配信だけを残す */
export const withinPeriod = (sessions: readonly SessionSummary[], days: number, now: number): SessionSummary[] => {
  const start = periodStart(days, now)
  return sessions.filter((session) => Date.parse(session.startedAt) >= start)
}

/** 配信の長さ（ミリ秒）。配信中なら開始から現在まで */
export const sessionDurationMs = (session: SessionSummary, now: number): number =>
  (session.endedAt === null ? now : Date.parse(session.endedAt)) - Date.parse(session.startedAt)

/** ある時点で最新のフォロワー数。その時点より前の記録が無ければ、いちばん古い記録を使う */
const followerTotalAt = (samples: readonly FollowerSample[], at: number): number | null => {
  const before = samples.filter((sample) => Date.parse(sample.sampledAt) <= at)
  const latest = before.at(-1) ?? samples[0]
  return latest ? latest.followerTotal : null
}

/**
 * 期間の概要を集計する。
 *
 * 平均視聴者数は配信時間で重み付けする（短い配信と長い配信を同じ重みで平均すると実態から離れるため）。
 * 視聴者数の記録がある配信だけを対象にし、1つも無ければ null を返す。
 *
 * @param samples フォロワー数の時系列（古い順）
 * @param days 期間（日数）
 * @param now 現在時刻（ミリ秒）
 */
export const summarize = (sessions: readonly SessionSummary[], samples: readonly FollowerSample[], days: number, now: number): Overview => {
  const target = withinPeriod(sessions, days, now)
  const withViewers = target.filter((session) => session.averageViewers !== null)
  const weightedMs = withViewers.reduce((total, session) => total + sessionDurationMs(session, now), 0)
  const weightedViewers = withViewers.reduce((total, session) => total + (session.averageViewers ?? 0) * sessionDurationMs(session, now), 0)
  const peaks = target.map((session) => session.peakViewers).filter((peak): peak is number => peak !== null)

  const start = periodStart(days, now)
  const followerTotal = samples.at(-1)?.followerTotal ?? null
  const followerAtStart = followerTotalAt(samples, start)

  return {
    streamCount: target.length,
    totalDurationMs: target.reduce((total, session) => total + sessionDurationMs(session, now), 0),
    // 重み（配信時間）の合計が0のときに割り算をしないよう、記録のある配信があるかで先に分ける
    averageViewers: withViewers.length === 0 || weightedMs === 0 ? null : Math.round((weightedViewers / weightedMs) * 10) / 10,
    peakViewers: peaks.length === 0 ? null : Math.max(...peaks),
    followerTotal,
    followerDelta: followerTotal === null || followerAtStart === null ? null : followerTotal - followerAtStart,
  }
}

/** 配信1回のイベントの件数。サブスクは新規と継続の報告を足す */
export const eventTotals = (session: SessionSummary): EventTotals => {
  const count = (type: string): number => session.eventCounts[type] ?? 0
  return {
    subscriptions: count(SUBSCRIBE) + count(SUBSCRIPTION_MESSAGE),
    redemptions: count(REDEMPTION),
    raids: count(RAID),
  }
}

/** 視聴者数の時系列を、グラフに渡す点の列にする */
export const viewerPoints = (samples: readonly ViewerSample[]): ViewerPoint[] =>
  samples.map((sample) => ({ at: Date.parse(sample.sampledAt), viewers: sample.viewerCount }))

/**
 * フォロワー数の時系列を、期間内のグラフに渡す点の列にする。
 *
 * フォロワー数は値が変わった時点しか記録されないので、期間の開始時点の値を先頭に足す（線が途中から始まらないようにする）。
 */
export const followerPoints = (samples: readonly FollowerSample[], days: number, now: number): FollowerPoint[] => {
  const start = periodStart(days, now)
  const atStart = followerTotalAt(samples, start)
  if (atStart === null) return []
  const inPeriod = samples.filter((sample) => Date.parse(sample.sampledAt) > start)
  return [{ at: start, followers: atStart }, ...inPeriod.map((sample) => ({ at: Date.parse(sample.sampledAt), followers: sample.followerTotal }))]
}

/** 長さ（ミリ秒）を「3時間30分」のように表す */
export const formatDuration = (milliseconds: number): string => {
  const minutes = Math.floor(milliseconds / MS_PER_MINUTE)
  const hours = Math.floor(minutes / 60)
  return hours === 0 ? `${minutes}分` : `${hours}時間${minutes % 60}分`
}

/** 日時（ISO 8601）を、ブラウザのタイムゾーンで「2026/9/18 21:00」のように表す */
export const formatDateTime = (iso: string): string =>
  new Date(iso).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** 時刻（ミリ秒）を、ブラウザのタイムゾーンで「9/18 21:00」のように表す（グラフの目盛り用） */
export const formatShortTime = (at: number): string =>
  new Date(at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** 件数や人数を表す。記録が無い（null）ときは「—」にして、0と区別する */
export const formatCount = (value: number | null): string => (value === null ? '—' : String(value))

/** 増減を「+4」「-2」のように符号付きで表す。記録が無ければ「—」 */
export const formatDelta = (value: number | null): string => (value === null ? '—' : value > 0 ? `+${value}` : String(value))
