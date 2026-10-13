/**
 * 配信の記録の集計・整形
 *
 * Workerから受け取った記録（api.ts）を、ダッシュボードが出す形に変える。
 * 表示（React）とは切り離してあるので、ここだけをテストできる。
 *
 * 注意: 記録が無いことと 0 は別物として扱う。記録が無い値は null のまま持ち、表示のときに「—」にする（Fail-Fast）。
 * 日時は配信者のブラウザのタイムゾーンで表示する（Date の既定のタイムゾーンに任せる）。
 * レイドの後の定着（直前・30分後・60分後の視聴者数）は、Worker が5分おきに記録した視聴者数（samples）から求め、
 * 配信が先に終わった・記録が欠けたときは値を作らず理由を持つ（raidRetention）。
 */
import type { FollowerSample, SessionSummary, StreamChapter, StreamRaid, ViewerSample, WorkTime } from './api'

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

/** 配信1回のイベントの件数。サブスクは新規と継続の報告を追加する */
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
 * フォロワー数は値が変わった時点しか記録されないので、期間の開始時点の値を先頭に追加する（線が途中から始まらないようにする）。
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

/** 作業机でみんなが作業した時間の合計を「14時間32分（5人）」のように表す。記録が無ければ 0 ではなく「—」にする */
export const formatWorkTime = (workTime: WorkTime | null): string =>
  workTime === null ? '—' : `${formatDuration(workTime.totalMs)}（${workTime.people}人）`

/**
 * 章のチャットの件数と発言者数を「12件・5人」のように表す。
 *
 * 数を残す前（migrations/0036_chapter_chat_counts.sql より前）に作った章は null なので、0件と取り違えないよう「記録なし」にする。
 * ほかの値の「—」と違って言葉にするのは、「チャット —」だけでは何が無いのかが読み取りにくいためである。
 */
export const formatChapterChat = ({ chatCount, chatterCount }: Pick<StreamChapter, 'chatCount' | 'chatterCount'>): string =>
  chatCount === null || chatterCount === null ? '記録なし' : `${chatCount}件・${chatterCount}人`

/** 日時（ISO 8601）を、ブラウザのタイムゾーンで「2026/9/18 21:00」のように表す */
export const formatDateTime = (iso: string): string =>
  new Date(iso).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** 時刻（ISO 8601）を、ブラウザのタイムゾーンで「21:00」のように表す */
export const formatClockTime =(iso: string): string => new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })

/** 章の区間（ISO 8601 の始まりと終わり）を、ブラウザのタイムゾーンで「21:00〜21:30」のように表す */
export const formatTimeRange = (startIso: string, endIso: string): string => `${formatClockTime(startIso)}〜${formatClockTime(endIso)}`

/** 時刻（ミリ秒）を、ブラウザのタイムゾーンで「9/18 21:00」のように表す（グラフの目盛り用） */
export const formatShortTime = (at: number): string =>
  new Date(at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** 件数や人数を表す。記録が無い（null）ときは「—」にして、0と区別する */
export const formatCount = (value: number | null): string => (value === null ? '—' : String(value))

/** 増減を「+4」「-2」のように符号付きで表す。記録が無ければ「—」 */
export const formatDelta = (value: number | null): string => (value === null ? '—' : value > 0 ? `+${value}` : String(value))

/** レイドの後の定着を見る時点（レイドから何分後か） */
const RETENTION_MINUTES = { after30: 30, after60: 60 } as const
/**
 * ある時刻の視聴者数として読む記録の、時刻とのずれの上限（ミリ秒）。
 *
 * 記録は cron で5分おきなので、1回取りこぼしても読めるよう2回ぶん（10分）まで許す。
 * これを超えて離れた記録は別の時点の値なので使わず「記録なし」にする（前後の値で埋めない）。
 */
const RETENTION_SAMPLE_TOLERANCE_MS = 10 * MS_PER_MINUTE

/**
 * ある時点の視聴者数。値が無いときは理由を持つ。
 *
 * - recorded: 記録から読めた
 * - ended: その時点より先に配信が終わっていた
 * - pending: 配信中で、まだその時点になっていない
 * - missing: その時点の近くに記録が無い（収集が止まっていたなど）
 */
export type RetentionCount = { status: 'recorded'; viewers: number } | { status: 'ended' } | { status: 'pending' } | { status: 'missing' }

/** レイド1件の、直前・30分後・60分後の視聴者数 */
export interface RaidRetention {
  before: RetentionCount
  after30: RetentionCount
  after60: RetentionCount
}

/** 時刻 at にいちばん近い記録を、ずれの上限の内から選ぶ。filter で選べる記録を絞る */
const nearestSample = (samples: readonly ViewerSample[], at: number, filter: (sampledAt: number) => boolean): RetentionCount => {
  let nearest: { distance: number; viewers: number } | null = null
  for (const sample of samples) {
    const sampledAt = Date.parse(sample.sampledAt)
    const distance = Math.abs(sampledAt - at)
    if (!filter(sampledAt) || distance > RETENTION_SAMPLE_TOLERANCE_MS) continue
    if (nearest === null || distance < nearest.distance) nearest = { distance, viewers: sample.viewerCount }
  }
  return nearest === null ? { status: 'missing' } : { status: 'recorded', viewers: nearest.viewers }
}

/**
 * レイドの後の定着を求める（issue #353）。
 *
 * 直前の視聴者数は、レイドの時刻以前の記録だけから選ぶ（レイドで増えたあとの値を「直前」にしない）。
 * 30分後・60分後は、その時刻にいちばん近い記録を読む。配信がその時刻より先に終わっていたら「配信終了」、
 * 配信中でまだその時刻になっていなければ「まだ」とし、どちらも値を作らない。
 *
 * @param samples その配信の視聴者数の記録
 * @param endedAt 配信の終わり。配信中なら null
 * @param now 現在時刻（ミリ秒）
 */
export const raidRetention = (raid: StreamRaid, samples: readonly ViewerSample[], endedAt: string | null, now: number): RaidRetention => {
  const raidAt = Date.parse(raid.occurredAt)
  const endedAtMs = endedAt === null ? null : Date.parse(endedAt)
  const after = (minutes: number): RetentionCount => {
    const at = raidAt + minutes * MS_PER_MINUTE
    if (endedAtMs !== null && endedAtMs < at) return { status: 'ended' }
    if (endedAtMs === null && now < at) return { status: 'pending' }
    return nearestSample(samples, at, () => true)
  }
  return {
    before: nearestSample(samples, raidAt, (sampledAt) => sampledAt <= raidAt),
    after30: after(RETENTION_MINUTES.after30),
    after60: after(RETENTION_MINUTES.after60),
  }
}

/** ある時点の視聴者数を「28人」のように表す。値が無ければ理由（配信終了・まだ・記録なし）を出す */
export const formatRetention = (count: RetentionCount): string => {
  switch (count.status) {
    case 'recorded':
      return `${count.viewers}人`
    case 'ended':
      return '配信終了'
    case 'pending':
      return 'まだ'
    case 'missing':
      return '記録なし'
  }
}

/**
 * レイド元を「まつもと（matsumoto_dev）」のように表す。表示名がログイン名と大文字小文字の違いだけなら表示名だけにする。
 * レイド元を残しはじめる前のレイドは「—」
 */
export const formatRaidSource = (raid: StreamRaid): string => {
  if (raid.fromUserName === null || raid.fromUserLogin === null) return '—'
  return raid.fromUserName.toLowerCase() === raid.fromUserLogin.toLowerCase() ? raid.fromUserName : `${raid.fromUserName}（${raid.fromUserLogin}）`
}

/** レイドで連れてきた人数を「20人」のように表す。記録が無ければ「—」 */
export const formatRaidViewers = (raid: StreamRaid): string => (raid.viewers === null ? '—' : `${raid.viewers}人`)
