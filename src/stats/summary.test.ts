/**
 * 配信の記録の集計・整形（summary.ts）のテスト
 *
 * 表示（React）とは切り離し、期間での絞り込み・概要の集計・日時や長さの整形だけを確認する。
 * 日時はブラウザのタイムゾーンで表示する決まりなので、テストでは TZ を東京に固定して確かめる。
 */
import { describe, expect, it } from 'vitest'
import type { FollowerSample, SessionSummary, StreamRaid, ViewerSample } from './api'
import {
  formatChapterChat,
  formatProbability,
  formatRaidSource,
  formatRaidViewers,
  formatRetention,
  raidRetention,
  eventTotals,
  followerPoints,
  formatCount,
  formatDateTime,
  formatTimeRange,
  formatDelta,
  formatDuration,
  formatShortTime,
  formatWorkTime,
  sessionDurationMs,
  summarize,
  viewerPoints,
  withinPeriod,
} from './summary'

// 日時の整形はブラウザのタイムゾーンに従う。テストの結果が実行環境で変わらないよう、東京に固定する
process.env.TZ = 'Asia/Tokyo'

/** テストの「現在時刻」。2026年9月21日 21:00（東京） */
const NOW = Date.parse('2026-09-21T12:00:00.000Z')

const testSession = (patch: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'startedAt'>): SessionSummary => ({
  endedAt: null,
  title: 'もくもく配信',
  categoryName: 'Software and Game Development',
  averageViewers: null,
  peakViewers: null,
  followerDelta: null,
  eventCounts: {},
  ...patch,
})

const FRIDAY_SESSION = testSession({
  id: '配信ID-金曜',
  startedAt: '2026-09-18T12:00:00.000Z',
  endedAt: '2026-09-18T15:30:00.000Z',
  title: '金曜夜のもくもく配信',
  averageViewers: 12.5,
  peakViewers: 31,
  followerDelta: 4,
  eventCounts: { 'channel.subscribe': 2, 'channel.subscription.message': 1, 'channel.raid': 3 },
})

const LAST_MONTH_SESSION = testSession({
  id: '配信ID-先月',
  startedAt: '2026-08-10T12:00:00.000Z',
  endedAt: '2026-08-10T13:00:00.000Z',
  title: '先月の配信',
  averageViewers: 40,
  peakViewers: 60,
})

describe('withinPeriod（期間での絞り込み）', () => {
  it('指定した日数より前に始まった配信を除く', () => {
    expect(withinPeriod([FRIDAY_SESSION, LAST_MONTH_SESSION], 7, NOW).map((session) => session.id)).toEqual(['配信ID-金曜'])
    expect(withinPeriod([FRIDAY_SESSION, LAST_MONTH_SESSION], 90, NOW).map((session) => session.id)).toEqual(['配信ID-金曜', '配信ID-先月'])
  })
})

describe('sessionDurationMs（配信の長さ）', () => {
  it('終了している配信は、開始から終了までの長さを返す', () => {
    expect(sessionDurationMs(FRIDAY_SESSION, NOW)).toBe(3.5 * 60 * 60 * 1000)
  })

  it('配信中（endedAt が null）は、開始から現在までの長さを返す', () => {
    const liveSession = testSession({ id: '配信ID-いま', startedAt: '2026-09-21T11:00:00.000Z' })
    expect(sessionDurationMs(liveSession, NOW)).toBe(60 * 60 * 1000)
  })
})

describe('summarize（概要の集計）', () => {
  const FOLLOWER_TREND: FollowerSample[] = [
    { sampledAt: '2026-08-01T00:00:00.000Z', followerTotal: 90 },
    { sampledAt: '2026-09-18T12:00:00.000Z', followerTotal: 100 },
    { sampledAt: '2026-09-18T15:00:00.000Z', followerTotal: 104 },
  ]

  it('期間内の配信回数・配信時間・平均視聴者数・最大視聴者数を出す', () => {
    const overview = summarize([FRIDAY_SESSION, LAST_MONTH_SESSION], FOLLOWER_TREND, 7, NOW)

    expect(overview.streamCount).toBe(1)
    expect(overview.totalDurationMs).toBe(3.5 * 60 * 60 * 1000)
    expect(overview.averageViewers).toBe(12.5)
    expect(overview.peakViewers).toBe(31)
  })

  it('平均視聴者数は、記録のある配信だけを配信時間で重み付けして出す', () => {
    const shortSession = testSession({
      id: '配信ID-短い',
      startedAt: '2026-09-20T12:00:00.000Z',
      endedAt: '2026-09-20T13:00:00.000Z',
      averageViewers: 4,
      peakViewers: 5,
    })
    const sessionWithoutRecords = testSession({ id: '配信ID-記録なし', startedAt: '2026-09-19T12:00:00.000Z', endedAt: '2026-09-19T13:00:00.000Z' })

    // 3.5時間×12.5人 と 1時間×4人 の加重平均は (43.75 + 4) / 4.5 = 10.6 人
    expect(summarize([FRIDAY_SESSION, shortSession, sessionWithoutRecords], FOLLOWER_TREND, 7, NOW).averageViewers).toBe(10.6)
  })

  it('視聴者数の記録がまったく無ければ、平均も最大も null にする（0人と言い切らない）', () => {
    const sessionWithoutRecords = testSession({ id: '配信ID-記録なし', startedAt: '2026-09-19T12:00:00.000Z', endedAt: '2026-09-19T13:00:00.000Z' })
    const overview = summarize([sessionWithoutRecords], FOLLOWER_TREND, 7, NOW)

    expect(overview.averageViewers).toBeNull()
    expect(overview.peakViewers).toBeNull()
  })

  it('フォロワー数は最新の記録、増減は期間の開始時点との差を出す', () => {
    const overview = summarize([FRIDAY_SESSION], FOLLOWER_TREND, 7, NOW)

    expect(overview.followerTotal).toBe(104)
    // 7日前（9月14日）時点で最新の記録は90人なので、104 − 90 = 14人増えた
    expect(overview.followerDelta).toBe(14)
  })

  it('期間の開始時点より前に記録が無ければ、いちばん古い記録を起点にする', () => {
    const overview = summarize([FRIDAY_SESSION], [{ sampledAt: '2026-09-18T12:00:00.000Z', followerTotal: 100 }], 7, NOW)

    expect(overview.followerTotal).toBe(100)
    expect(overview.followerDelta).toBe(0)
  })

  it('フォロワー数の記録が無ければ、総数も増減も null にする', () => {
    const overview = summarize([FRIDAY_SESSION], [], 7, NOW)

    expect(overview.followerTotal).toBeNull()
    expect(overview.followerDelta).toBeNull()
  })
})

describe('eventTotals（イベントの件数）', () => {
  it('サブスクは新規と継続を追加し、ポイント交換とレイドはそれぞれ数える', () => {
    const sessionWithRedemptions = testSession({
      id: '配信ID-交換',
      startedAt: '2026-09-18T12:00:00.000Z',
      eventCounts: { 'channel.subscribe': 2, 'channel.subscription.message': 1, 'channel.channel_points_custom_reward_redemption.add': 7, 'channel.raid': 3 },
    })

    expect(eventTotals(sessionWithRedemptions)).toEqual({ subscriptions: 3, redemptions: 7, raids: 3 })
  })

  it('イベントの記録が無ければ、すべて0にする', () => {
    expect(eventTotals(testSession({ id: '配信ID-なし', startedAt: '2026-09-18T12:00:00.000Z' }))).toEqual({ subscriptions: 0, redemptions: 0, raids: 0 })
  })
})

describe('viewerPoints・followerPoints（グラフに渡す点の列）', () => {
  it('視聴者数の推移は、時刻をミリ秒にして並べる', () => {
    const trend = viewerPoints([
      { sampledAt: '2026-09-18T12:05:00.000Z', viewerCount: 8 },
      { sampledAt: '2026-09-18T12:10:00.000Z', viewerCount: 15 },
    ])

    expect(trend).toEqual([
      { at: Date.parse('2026-09-18T12:05:00.000Z'), viewers: 8 },
      { at: Date.parse('2026-09-18T12:10:00.000Z'), viewers: 15 },
    ])
  })

  it('フォロワー数の推移は期間内に絞り、期間の開始時点の値を先頭に追加する（線が途中から始まらないようにする）', () => {
    const trend = followerPoints(
      [
        { sampledAt: '2026-08-01T00:00:00.000Z', followerTotal: 90 },
        { sampledAt: '2026-09-18T12:00:00.000Z', followerTotal: 100 },
      ],
      7,
      NOW,
    )

    expect(trend).toEqual([
      { at: NOW - 7 * 24 * 60 * 60 * 1000, followers: 90 },
      { at: Date.parse('2026-09-18T12:00:00.000Z'), followers: 100 },
    ])
  })

  it('フォロワー数の記録が無ければ、空の列にする', () => {
    expect(followerPoints([], 7, NOW)).toEqual([])
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

describe('formatTimeRange（章の区間の時刻）', () => {
  it('始まりと終わりを、ブラウザのタイムゾーンの時刻で「21:00〜21:30」のように表す', () => {
    expect(formatTimeRange('2026-09-18T12:00:00.000Z', '2026-09-18T12:30:00.000Z')).toBe('21:00〜21:30')
  })
})

describe('formatChapterChat（章のチャットの件数と発言者数）', () => {
  it('件数と人数を「12件・5人」のように表す', () => {
    expect(formatChapterChat({ chatCount: 12, chatterCount: 5 })).toBe('12件・5人')
    expect(formatChapterChat({ chatCount: 0, chatterCount: 0 })).toBe('0件・0人')
  })

  it('数を残す前に作った章（null）は、0件と取り違えないよう「記録なし」にする', () => {
    expect(formatChapterChat({ chatCount: null, chatterCount: null })).toBe('記録なし')
  })
})

describe('formatProbability（Jev の確率）', () => {
  it('0〜1 の確率を、整数に丸めた百分率で表す', () => {
    expect(formatProbability(0.934)).toBe('93%')
    expect(formatProbability(0.006)).toBe('1%')
    expect(formatProbability(1)).toBe('100%')
  })
})

describe('formatWorkTime（作業机でみんなが作業した時間の合計）', () => {
  it('合計を「◯時間◯分（◯人）」で表す', () => {
    expect(formatWorkTime({ people: 5, totalMs: (14 * 60 + 32) * 60 * 1000 })).toBe('14時間32分（5人）')
  })

  it('記録が無ければ 0 ではなく「—」にする', () => {
    expect(formatWorkTime(null)).toBe('—')
  })
})

describe('raidRetention（レイドの後の定着）', () => {
  /** 12:41（UTC）に「まつもと」が20人でレイドしてきた */
  const RAID: StreamRaid = {
    occurredAt: '2026-09-23T12:41:00.000Z',
    fromUserId: '33333',
    fromUserLogin: 'matsumoto_dev',
    fromUserName: 'まつもと',
    viewers: 20,
  }
  /** 5分おきの視聴者数。レイドの直前は9人、30分後は28人、60分後は17人 */
  const SAMPLES: ViewerSample[] = [
    { sampledAt: '2026-09-23T12:30:00.000Z', viewerCount: 7 },
    { sampledAt: '2026-09-23T12:40:00.000Z', viewerCount: 9 },
    { sampledAt: '2026-09-23T12:45:00.000Z', viewerCount: 36 },
    { sampledAt: '2026-09-23T13:10:00.000Z', viewerCount: 28 },
    { sampledAt: '2026-09-23T13:40:00.000Z', viewerCount: 17 },
  ]
  /** 配信がとうに終わったあとの時刻 */
  const LATER = Date.parse('2026-09-24T00:00:00.000Z')

  it('直前・30分後・60分後の視聴者数を、それぞれいちばん近い記録から読む', () => {
    expect(raidRetention(RAID, SAMPLES, '2026-09-23T15:00:00.000Z', LATER)).toEqual({
      before: { status: 'recorded', viewers: 9 },
      after30: { status: 'recorded', viewers: 28 },
      after60: { status: 'recorded', viewers: 17 },
    })
  })

  it('30分後・60分後より先に配信が終わっていたら、値を作らず「配信終了」にする', () => {
    expect(raidRetention(RAID, SAMPLES, '2026-09-23T13:20:00.000Z', LATER)).toMatchObject({
      after30: { status: 'recorded', viewers: 28 },
      after60: { status: 'ended' },
    })
  })

  it('配信中で、まだその時刻になっていなければ「まだ」にする', () => {
    expect(raidRetention(RAID, SAMPLES.slice(0, 3), null, Date.parse('2026-09-23T12:50:00.000Z'))).toMatchObject({
      after30: { status: 'pending' },
      after60: { status: 'pending' },
    })
  })

  it('その時刻の近くに記録が無ければ、前後の値で埋めずに「記録なし」にする', () => {
    // 13:10 の記録が欠けている（収集が止まっていた）
    const withGap = SAMPLES.filter((sample) => sample.sampledAt !== '2026-09-23T13:10:00.000Z')
    expect(raidRetention(RAID, withGap, '2026-09-23T15:00:00.000Z', LATER)).toMatchObject({ after30: { status: 'missing' } })
  })

  it('レイドより前の近くに記録が無ければ、直前の視聴者数も「記録なし」にする（レイドのあとの記録は使わない）', () => {
    const afterRaidOnly = SAMPLES.filter((sample) => sample.sampledAt >= '2026-09-23T12:45:00.000Z')
    expect(raidRetention(RAID, afterRaidOnly, '2026-09-23T15:00:00.000Z', LATER).before).toEqual({ status: 'missing' })
  })
})

describe('レイドの整形', () => {
  it('レイド元は表示名とログイン名を並べる。表示名がログイン名と同じ綴りなら1つだけにする', () => {
    expect(formatRaidSource({ occurredAt: '', fromUserId: '1', fromUserLogin: 'matsumoto_dev', fromUserName: 'まつもと', viewers: 20 })).toBe('まつもと（matsumoto_dev）')
    expect(formatRaidSource({ occurredAt: '', fromUserId: '1', fromUserLogin: 'matsumoto_dev', fromUserName: 'Matsumoto_Dev', viewers: 20 })).toBe('Matsumoto_Dev')
  })

  it('レイド元を残す前のレイドは、レイド元も人数も「—」にする', () => {
    const oldRaid: StreamRaid = { occurredAt: '', fromUserId: null, fromUserLogin: null, fromUserName: null, viewers: null }
    expect(formatRaidSource(oldRaid)).toBe('—')
    expect(formatRaidViewers(oldRaid)).toBe('—')
    expect(formatRaidViewers({ ...oldRaid, viewers: 20 })).toBe('20人')
  })

  it('視聴者数は人数で、無いときは理由を出す', () => {
    expect(formatRetention({ status: 'recorded', viewers: 28 })).toBe('28人')
    expect(formatRetention({ status: 'ended' })).toBe('配信終了')
    expect(formatRetention({ status: 'pending' })).toBe('まだ')
    expect(formatRetention({ status: 'missing' })).toBe('記録なし')
  })
})
