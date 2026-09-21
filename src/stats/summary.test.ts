/**
 * 配信の記録の集計・整形（summary.ts）のテスト
 *
 * 表示（React）とは切り離し、期間での絞り込み・概要の集計・日時や長さの整形だけを確認する。
 * 日時はブラウザのタイムゾーンで表示する決まりなので、テストでは TZ を東京に固定して確かめる。
 */
import { describe, expect, it } from 'vitest'
import type { FollowerSample, SessionSummary } from './api'
import {
  eventTotals,
  followerPoints,
  formatCount,
  formatDateTime,
  formatDelta,
  formatDuration,
  formatShortTime,
  sessionDurationMs,
  summarize,
  viewerPoints,
  withinPeriod,
} from './summary'

// 日時の整形はブラウザのタイムゾーンに従う。テストの結果が実行環境で変わらないよう、東京に固定する
process.env.TZ = 'Asia/Tokyo'

/** テストの「現在時刻」。2026年9月21日 21:00（東京） */
const 現在 = Date.parse('2026-09-21T12:00:00.000Z')

const 配信 = (patch: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'startedAt'>): SessionSummary => ({
  endedAt: null,
  title: 'もくもく配信',
  categoryName: 'Software and Game Development',
  averageViewers: null,
  peakViewers: null,
  followerDelta: null,
  eventCounts: {},
  ...patch,
})

const 金曜の配信 = 配信({
  id: '配信ID-金曜',
  startedAt: '2026-09-18T12:00:00.000Z',
  endedAt: '2026-09-18T15:30:00.000Z',
  title: '金曜夜のもくもく配信',
  averageViewers: 12.5,
  peakViewers: 31,
  followerDelta: 4,
  eventCounts: { 'channel.subscribe': 2, 'channel.subscription.message': 1, 'channel.raid': 3 },
})

const 先月の配信 = 配信({
  id: '配信ID-先月',
  startedAt: '2026-08-10T12:00:00.000Z',
  endedAt: '2026-08-10T13:00:00.000Z',
  title: '先月の配信',
  averageViewers: 40,
  peakViewers: 60,
})

describe('withinPeriod（期間での絞り込み）', () => {
  it('指定した日数より前に始まった配信を除く', () => {
    expect(withinPeriod([金曜の配信, 先月の配信], 7, 現在).map((session) => session.id)).toEqual(['配信ID-金曜'])
    expect(withinPeriod([金曜の配信, 先月の配信], 90, 現在).map((session) => session.id)).toEqual(['配信ID-金曜', '配信ID-先月'])
  })
})

describe('sessionDurationMs（配信の長さ）', () => {
  it('終了している配信は、開始から終了までの長さを返す', () => {
    expect(sessionDurationMs(金曜の配信, 現在)).toBe(3.5 * 60 * 60 * 1000)
  })

  it('配信中（endedAt が null）は、開始から現在までの長さを返す', () => {
    const 配信中 = 配信({ id: '配信ID-いま', startedAt: '2026-09-21T11:00:00.000Z' })
    expect(sessionDurationMs(配信中, 現在)).toBe(60 * 60 * 1000)
  })
})

describe('summarize（概要の集計）', () => {
  const フォロワーの推移: FollowerSample[] = [
    { sampledAt: '2026-08-01T00:00:00.000Z', followerTotal: 90 },
    { sampledAt: '2026-09-18T12:00:00.000Z', followerTotal: 100 },
    { sampledAt: '2026-09-18T15:00:00.000Z', followerTotal: 104 },
  ]

  it('期間内の配信回数・配信時間・平均視聴者数・最大視聴者数を出す', () => {
    const 概要 = summarize([金曜の配信, 先月の配信], フォロワーの推移, 7, 現在)

    expect(概要.streamCount).toBe(1)
    expect(概要.totalDurationMs).toBe(3.5 * 60 * 60 * 1000)
    expect(概要.averageViewers).toBe(12.5)
    expect(概要.peakViewers).toBe(31)
  })

  it('平均視聴者数は、記録のある配信だけを配信時間で重み付けして出す', () => {
    const 短い配信 = 配信({
      id: '配信ID-短い',
      startedAt: '2026-09-20T12:00:00.000Z',
      endedAt: '2026-09-20T13:00:00.000Z',
      averageViewers: 4,
      peakViewers: 5,
    })
    const 記録のない配信 = 配信({ id: '配信ID-記録なし', startedAt: '2026-09-19T12:00:00.000Z', endedAt: '2026-09-19T13:00:00.000Z' })

    // 3.5時間×12.5人 と 1時間×4人 の加重平均は (43.75 + 4) / 4.5 = 10.6 人
    expect(summarize([金曜の配信, 短い配信, 記録のない配信], フォロワーの推移, 7, 現在).averageViewers).toBe(10.6)
  })

  it('視聴者数の記録がまったく無ければ、平均も最大も null にする（0人と言い切らない）', () => {
    const 記録のない配信 = 配信({ id: '配信ID-記録なし', startedAt: '2026-09-19T12:00:00.000Z', endedAt: '2026-09-19T13:00:00.000Z' })
    const 概要 = summarize([記録のない配信], フォロワーの推移, 7, 現在)

    expect(概要.averageViewers).toBeNull()
    expect(概要.peakViewers).toBeNull()
  })

  it('フォロワー数は最新の記録、増減は期間の開始時点との差を出す', () => {
    const 概要 = summarize([金曜の配信], フォロワーの推移, 7, 現在)

    expect(概要.followerTotal).toBe(104)
    // 7日前（9月14日）時点で最新の記録は90人なので、104 − 90 = 14人増えた
    expect(概要.followerDelta).toBe(14)
  })

  it('期間の開始時点より前に記録が無ければ、いちばん古い記録を起点にする', () => {
    const 概要 = summarize([金曜の配信], [{ sampledAt: '2026-09-18T12:00:00.000Z', followerTotal: 100 }], 7, 現在)

    expect(概要.followerTotal).toBe(100)
    expect(概要.followerDelta).toBe(0)
  })

  it('フォロワー数の記録が無ければ、総数も増減も null にする', () => {
    const 概要 = summarize([金曜の配信], [], 7, 現在)

    expect(概要.followerTotal).toBeNull()
    expect(概要.followerDelta).toBeNull()
  })
})

describe('eventTotals（イベントの件数）', () => {
  it('サブスクは新規と継続を足し、ポイント交換とレイドはそれぞれ数える', () => {
    const 交換のある配信 = 配信({
      id: '配信ID-交換',
      startedAt: '2026-09-18T12:00:00.000Z',
      eventCounts: { 'channel.subscribe': 2, 'channel.subscription.message': 1, 'channel.channel_points_custom_reward_redemption.add': 7, 'channel.raid': 3 },
    })

    expect(eventTotals(交換のある配信)).toEqual({ subscriptions: 3, redemptions: 7, raids: 3 })
  })

  it('イベントの記録が無ければ、すべて0にする', () => {
    expect(eventTotals(配信({ id: '配信ID-なし', startedAt: '2026-09-18T12:00:00.000Z' }))).toEqual({ subscriptions: 0, redemptions: 0, raids: 0 })
  })
})

describe('viewerPoints・followerPoints（グラフに渡す点の列）', () => {
  it('視聴者数の推移は、時刻をミリ秒にして並べる', () => {
    const 推移 = viewerPoints([
      { sampledAt: '2026-09-18T12:05:00.000Z', viewerCount: 8 },
      { sampledAt: '2026-09-18T12:10:00.000Z', viewerCount: 15 },
    ])

    expect(推移).toEqual([
      { at: Date.parse('2026-09-18T12:05:00.000Z'), viewers: 8 },
      { at: Date.parse('2026-09-18T12:10:00.000Z'), viewers: 15 },
    ])
  })

  it('フォロワー数の推移は期間内に絞り、期間の開始時点の値を先頭に足す（線が途中から始まらないようにする）', () => {
    const 推移 = followerPoints(
      [
        { sampledAt: '2026-08-01T00:00:00.000Z', followerTotal: 90 },
        { sampledAt: '2026-09-18T12:00:00.000Z', followerTotal: 100 },
      ],
      7,
      現在,
    )

    expect(推移).toEqual([
      { at: 現在 - 7 * 24 * 60 * 60 * 1000, followers: 90 },
      { at: Date.parse('2026-09-18T12:00:00.000Z'), followers: 100 },
    ])
  })

  it('フォロワー数の記録が無ければ、空の列にする', () => {
    expect(followerPoints([], 7, 現在)).toEqual([])
  })
})

describe('formatDuration・formatDateTime・formatCount（表示用の整形）', () => {
  it('長さは時間と分で表す', () => {
    expect(formatDuration(3.5 * 60 * 60 * 1000)).toBe('3時間30分')
    expect(formatDuration(45 * 60 * 1000)).toBe('45分')
    expect(formatDuration(0)).toBe('0分')
  })

  it('日時はブラウザのタイムゾーン（ここでは東京）で表す', () => {
    expect(formatDateTime('2026-09-18T12:00:00.000Z')).toBe('2026/9/18 21:00')
  })

  it('記録が無い値（null）は「—」と表す（0と区別する）', () => {
    expect(formatCount(null)).toBe('—')
    expect(formatCount(0)).toBe('0')
    expect(formatCount(12.5)).toBe('12.5')
  })

  it('増減は符号を付けて表す', () => {
    expect(formatDelta(4)).toBe('+4')
    expect(formatDelta(-2)).toBe('-2')
    expect(formatDelta(0)).toBe('0')
    expect(formatDelta(null)).toBe('—')
  })

  it('グラフの目盛りの時刻は、年を省いてブラウザのタイムゾーンで表す', () => {
    expect(formatShortTime(Date.parse('2026-09-18T12:00:00.000Z'))).toBe('9/18 21:00')
  })
})
