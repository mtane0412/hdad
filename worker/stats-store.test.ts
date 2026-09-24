/**
 * 配信の記録の読み書き（stats-store.ts）のテスト
 *
 * D1の代わりにメモリ上のSQLite（fake-database.ts）へ migrations/ を適用し、実際のSQLを動かして確かめる。
 */
import { describe, expect, it } from 'vitest'
import { createFakeDatabase } from './fake-database'
import {
  closeOpenSessions,
  getSession,
  listFailures,
  listFollowerSamples,
  listSessions,
  recordEvent,
  recordFailure,
  recordFollowerTotal,
  recordLiveStream,
  recordStreamOffline,
  recordStreamOnline,
} from './stats-store'
import type { LiveStream } from './twitch'

const 時刻 = (text: string): number => Date.parse(text)

const 雑談配信: LiveStream = {
  id: '40000000001',
  startedAt: '2026-09-21T12:00:00.000Z',
  title: '月曜の雑談配信',
  categoryName: 'Just Chatting',
  viewerCount: 10,
}

describe('recordLiveStream', () => {
  it('配信中なら、セッションを開始して視聴者数を記録する', async () => {
    const db = createFakeDatabase()
    await recordLiveStream(db, 雑談配信, 時刻('2026-09-21T12:05:00Z'))

    expect(await getSession(db, 雑談配信.id)).toEqual({
      id: '40000000001',
      startedAt: '2026-09-21T12:00:00.000Z',
      endedAt: null,
      title: '月曜の雑談配信',
      categoryName: 'Just Chatting',
      samples: [{ sampledAt: '2026-09-21T12:05:00.000Z', viewerCount: 10 }],
    })
  })

  it('同じ配信が続いていれば、サンプルを足し、タイトルとカテゴリを最新にする', async () => {
    const db = createFakeDatabase()
    await recordLiveStream(db, 雑談配信, 時刻('2026-09-21T12:05:00Z'))
    await recordLiveStream(
      db,
      { ...雑談配信, title: 'ゲームに切り替えました', categoryName: 'Minecraft', viewerCount: 25 },
      時刻('2026-09-21T12:10:00Z'),
    )

    const session = await getSession(db, 雑談配信.id)
    expect(session?.title).toBe('ゲームに切り替えました')
    expect(session?.categoryName).toBe('Minecraft')
    expect(session?.samples).toEqual([
      { sampledAt: '2026-09-21T12:05:00.000Z', viewerCount: 10 },
      { sampledAt: '2026-09-21T12:10:00.000Z', viewerCount: 25 },
    ])
  })

  it('別の配信が始まっていたら、開いたままの前のセッションを、新しい配信の開始時刻で閉じる', async () => {
    const db = createFakeDatabase()
    await recordLiveStream(db, 雑談配信, 時刻('2026-09-21T12:05:00Z'))
    await recordLiveStream(db, { ...雑談配信, id: '40000000002', startedAt: '2026-09-21T15:00:00.000Z' }, 時刻('2026-09-21T15:05:00Z'))

    // 前の配信は、遅くとも新しい配信が始まるまでには終わっている
    expect((await getSession(db, '40000000001'))?.endedAt).toBe('2026-09-21T15:00:00.000Z')
    expect((await getSession(db, '40000000002'))?.endedAt).toBeNull()
  })

  it('閉じたはずの配信がまだ続いていたら、開き直す', async () => {
    const db = createFakeDatabase()
    await recordLiveStream(db, 雑談配信, 時刻('2026-09-21T12:05:00Z'))
    await closeOpenSessions(db, 時刻('2026-09-21T12:10:00Z'))
    await recordLiveStream(db, 雑談配信, 時刻('2026-09-21T12:15:00Z'))

    expect((await getSession(db, 雑談配信.id))?.endedAt).toBeNull()
  })

  it('同じ時刻に2回呼ばれても、サンプルを二重に記録しない', async () => {
    const db = createFakeDatabase()
    await recordLiveStream(db, 雑談配信, 時刻('2026-09-21T12:05:00Z'))
    await recordLiveStream(db, 雑談配信, 時刻('2026-09-21T12:05:00Z'))

    expect((await getSession(db, 雑談配信.id))?.samples).toHaveLength(1)
  })
})

describe('closeOpenSessions', () => {
  it('配信が終わっていたら、開いているセッションを閉じる。閉じ済みのセッションの終了時刻は変えない', async () => {
    const db = createFakeDatabase()
    await recordLiveStream(db, 雑談配信, 時刻('2026-09-21T12:05:00Z'))
    await closeOpenSessions(db, 時刻('2026-09-21T14:00:00Z'))
    await closeOpenSessions(db, 時刻('2026-09-21T14:05:00Z'))

    expect((await getSession(db, 雑談配信.id))?.endedAt).toBe('2026-09-21T14:00:00.000Z')
  })
})

describe('recordFollowerTotal', () => {
  it('フォロワー数は、前回から変わったときだけ記録する', async () => {
    const db = createFakeDatabase()
    await recordFollowerTotal(db, 100, 時刻('2026-09-21T12:00:00Z'))
    await recordFollowerTotal(db, 100, 時刻('2026-09-21T12:05:00Z'))
    await recordFollowerTotal(db, 103, 時刻('2026-09-21T12:10:00Z'))
    await recordFollowerTotal(db, 100, 時刻('2026-09-21T12:15:00Z'))

    expect(await listFollowerSamples(db)).toEqual([
      { sampledAt: '2026-09-21T12:00:00.000Z', followerTotal: 100 },
      { sampledAt: '2026-09-21T12:10:00.000Z', followerTotal: 103 },
      { sampledAt: '2026-09-21T12:15:00.000Z', followerTotal: 100 },
    ])
  })
})

describe('listSessions', () => {
  it('新しい配信から順に、平均・最大視聴者数、フォロワー増減、イベント件数を付けて返す', async () => {
    const db = createFakeDatabase()
    await recordFollowerTotal(db, 100, 時刻('2026-09-21T11:00:00Z'))
    await recordLiveStream(db, 雑談配信, 時刻('2026-09-21T12:05:00Z'))
    await recordLiveStream(db, { ...雑談配信, viewerCount: 25 }, 時刻('2026-09-21T12:10:00Z'))
    await recordFollowerTotal(db, 104, 時刻('2026-09-21T12:10:00Z'))
    await closeOpenSessions(db, 時刻('2026-09-21T12:15:00Z'))
    // 配信が終わったあとの増加は、この配信の増減に数えない
    await recordFollowerTotal(db, 110, 時刻('2026-09-21T13:00:00Z'))
    await recordLiveStream(db, { ...雑談配信, id: '40000000002', startedAt: '2026-09-22T12:00:00.000Z' }, 時刻('2026-09-22T12:05:00Z'))

    const イベントを足す = db.prepare('INSERT INTO stream_events (id, session_id, type, occurred_at) VALUES (?1, ?2, ?3, ?4)')
    await db.batch([
      イベントを足す.bind('message-1', 雑談配信.id, 'channel.subscribe', '2026-09-21T12:06:00.000Z'),
      イベントを足す.bind('message-2', 雑談配信.id, 'channel.subscribe', '2026-09-21T12:07:00.000Z'),
      イベントを足す.bind('message-3', 雑談配信.id, 'channel.raid', '2026-09-21T12:08:00.000Z'),
      イベントを足す.bind('message-4', null, 'channel.raid', '2026-09-21T20:00:00.000Z'),
    ])

    expect(await listSessions(db, 時刻('2026-09-22T12:05:00Z'))).toEqual([
      {
        id: '40000000002',
        startedAt: '2026-09-22T12:00:00.000Z',
        endedAt: null,
        title: '月曜の雑談配信',
        categoryName: 'Just Chatting',
        averageViewers: 10,
        peakViewers: 10,
        followerDelta: 0,
        eventCounts: {},
      },
      {
        id: '40000000001',
        startedAt: '2026-09-21T12:00:00.000Z',
        endedAt: '2026-09-21T12:15:00.000Z',
        title: '月曜の雑談配信',
        categoryName: 'Just Chatting',
        averageViewers: 17.5,
        peakViewers: 25,
        followerDelta: 4,
        eventCounts: { 'channel.subscribe': 2, 'channel.raid': 1 },
      },
    ])
  })

  it('記録を始める前のフォロワー数が無ければ、最初の記録を配信開始時の値として扱う', async () => {
    const db = createFakeDatabase()
    await recordLiveStream(db, 雑談配信, 時刻('2026-09-21T12:05:00Z'))
    await recordFollowerTotal(db, 100, 時刻('2026-09-21T12:05:00Z'))
    await recordFollowerTotal(db, 102, 時刻('2026-09-21T12:10:00Z'))

    const [session] = await listSessions(db, 時刻('2026-09-21T12:10:00Z'))
    expect(session?.followerDelta).toBe(2)
  })

  it('サンプルもフォロワー数の記録も無いセッションは、値を null にする', async () => {
    const db = createFakeDatabase()
    await db
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind('40000000009', '2026-09-20T12:00:00.000Z', '2026-09-20T13:00:00.000Z', '記録のない配信', '')
      .run()

    const [session] = await listSessions(db, 時刻('2026-09-21T12:00:00Z'))
    expect(session).toMatchObject({ averageViewers: null, peakViewers: null, followerDelta: null })
  })
})

describe('getSession', () => {
  it('存在しない配信は null を返す', async () => {
    expect(await getSession(createFakeDatabase(), '存在しないID')).toBeNull()
  })
})

describe('recordFailure', () => {
  it('収集の失敗を記録し、30日より古い記録は消す', async () => {
    const db = createFakeDatabase()
    await recordFailure(db, 'not-logged-in', '配信者がまだログインしていません', 時刻('2026-08-01T00:00:00Z'))
    await recordFailure(db, 'twitch-error', 'Twitchが 500 を返しました', 時刻('2026-09-20T00:00:00Z'))
    await recordFailure(db, 'relogin-required', 'ログインし直してください', 時刻('2026-09-21T00:00:00Z'))

    expect(await listFailures(db)).toEqual([
      { occurredAt: '2026-09-21T00:00:00.000Z', code: 'relogin-required', message: 'ログインし直してください' },
      { occurredAt: '2026-09-20T00:00:00.000Z', code: 'twitch-error', message: 'Twitchが 500 を返しました' },
    ])
  })

  it('1回の収集で種類の違う失敗が重なっても、どちらも残す', async () => {
    const db = createFakeDatabase()
    // cron は5分おきに複数の仕事（あらすじ・サイドスーパー・人物像）をまとめて行うので、
    // LLMの無料枠が切れた回では同じ時刻に別々の失敗が並ぶ。あとから起きた失敗が先の失敗を消してはならない
    await recordFailure(db, 'stream-summary-failed', 'あらすじを作れませんでした', 時刻('2026-09-21T12:05:00Z'))
    await recordFailure(db, 'side-super-failed', 'サイドスーパーを作れませんでした', 時刻('2026-09-21T12:05:00Z'))

    expect([...(await listFailures(db))].map((failure) => failure.code).sort()).toEqual(['side-super-failed', 'stream-summary-failed'])
  })

  it('同じ時刻に同じ種類の失敗が二度記録されても、行は増えない', async () => {
    const db = createFakeDatabase()
    await recordFailure(db, 'side-super-failed', '1回目の文面', 時刻('2026-09-21T12:05:00Z'))
    await recordFailure(db, 'side-super-failed', '2回目の文面', 時刻('2026-09-21T12:05:00Z'))

    expect(await listFailures(db)).toEqual([
      { occurredAt: '2026-09-21T12:05:00.000Z', code: 'side-super-failed', message: '2回目の文面' },
    ])
  })
})

describe('recordStreamOnline', () => {
  it('配信の開始を知らされたら、タイトルとカテゴリが空のセッションを開始する（次の cron が埋める）', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 雑談配信.id, startedAt: 時刻('2026-09-21T12:00:00Z') })

    expect(await getSession(db, 雑談配信.id)).toEqual({
      id: '40000000001',
      startedAt: '2026-09-21T12:00:00.000Z',
      endedAt: null,
      title: '',
      categoryName: '',
      samples: [],
    })

    await recordLiveStream(db, 雑談配信, 時刻('2026-09-21T12:05:00Z'))
    expect(await getSession(db, 雑談配信.id)).toMatchObject({ title: '月曜の雑談配信', categoryName: 'Just Chatting' })
  })

  it('cron が先に記録していたセッションは書き換えない。閉じ済みのセッションを開き直すこともしない（通知の再送に備える）', async () => {
    const db = createFakeDatabase()
    await recordLiveStream(db, 雑談配信, 時刻('2026-09-21T12:05:00Z'))
    await closeOpenSessions(db, 時刻('2026-09-21T14:00:00Z'))
    await recordStreamOnline(db, { id: 雑談配信.id, startedAt: 時刻('2026-09-21T12:00:00Z') })

    expect(await getSession(db, 雑談配信.id)).toMatchObject({ title: '月曜の雑談配信', endedAt: '2026-09-21T14:00:00.000Z' })
  })

  it('開いたままの前のセッションは、新しい配信の開始時刻で閉じる', async () => {
    const db = createFakeDatabase()
    await recordLiveStream(db, 雑談配信, 時刻('2026-09-21T12:05:00Z'))
    await recordStreamOnline(db, { id: '40000000002', startedAt: 時刻('2026-09-22T12:00:00Z') })

    expect((await getSession(db, 雑談配信.id))?.endedAt).toBe('2026-09-22T12:00:00.000Z')
    expect((await getSession(db, '40000000002'))?.endedAt).toBeNull()
  })
})

describe('recordStreamOffline', () => {
  it('配信の終了を知らされたら、開いているセッションをその時刻で閉じる。あとから cron が来ても終了時刻は変わらない', async () => {
    const db = createFakeDatabase()
    await recordLiveStream(db, 雑談配信, 時刻('2026-09-21T12:05:00Z'))
    await recordStreamOffline(db, 時刻('2026-09-21T13:58:30Z'))
    await closeOpenSessions(db, 時刻('2026-09-21T14:00:00Z'))

    expect((await getSession(db, 雑談配信.id))?.endedAt).toBe('2026-09-21T13:58:30.000Z')
  })

  it('遅れて届いた前の配信の終了で、そのあとに始まった配信を閉じない', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: '40000000002', startedAt: 時刻('2026-09-22T12:00:00Z') })
    await recordStreamOffline(db, 時刻('2026-09-21T13:58:30Z'))

    expect((await getSession(db, '40000000002'))?.endedAt).toBeNull()
  })
})

describe('recordEvent', () => {
  const イベントの行 = (db: ReturnType<typeof createFakeDatabase>) =>
    db.sqlite.prepare('SELECT id, session_id AS sessionId, type, occurred_at AS occurredAt FROM stream_events ORDER BY occurred_at').all()

  it('配信中のイベントは、開いているセッションに結び付けて記録する', async () => {
    const db = createFakeDatabase()
    await recordLiveStream(db, 雑談配信, 時刻('2026-09-21T12:05:00Z'))
    await recordEvent(db, { id: 'メッセージ1', type: 'channel.raid', occurredAt: 時刻('2026-09-21T12:30:00Z') })

    expect(イベントの行(db)).toEqual([
      { id: 'メッセージ1', sessionId: '40000000001', type: 'channel.raid', occurredAt: '2026-09-21T12:30:00.000Z' },
    ])
    expect((await listSessions(db, 時刻('2026-09-21T13:00:00Z')))[0]?.eventCounts).toEqual({ 'channel.raid': 1 })
  })

  it('配信していないときのイベントは、セッションなしで記録する', async () => {
    const db = createFakeDatabase()
    await recordLiveStream(db, 雑談配信, 時刻('2026-09-21T12:05:00Z'))
    await closeOpenSessions(db, 時刻('2026-09-21T14:00:00Z'))
    await recordEvent(db, { id: 'メッセージ1', type: 'channel.subscribe', occurredAt: 時刻('2026-09-21T20:00:00Z') })

    expect(イベントの行(db)).toMatchObject([{ id: 'メッセージ1', sessionId: null }])
  })

  it('同じメッセージIDが再送されても、二重に数えない', async () => {
    const db = createFakeDatabase()
    await recordEvent(db, { id: 'メッセージ1', type: 'channel.subscribe', occurredAt: 時刻('2026-09-21T20:00:00Z') })
    await recordEvent(db, { id: 'メッセージ1', type: 'channel.subscribe', occurredAt: 時刻('2026-09-21T20:00:00Z') })

    expect(イベントの行(db)).toHaveLength(1)
  })
})
