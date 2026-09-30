import { beforeEach, describe, expect, it } from 'vitest'
import { createFakeDatabase } from './fake-database'
import { deleteOldTranscripts, readRecentTranscripts, readTranscriptsSince, recordTranscript } from './transcript-store'

const STREAM_START = Date.parse('2026-09-23T20:00:00.000Z')
const speechTime = Date.parse('2026-09-23T20:05:00.000Z')

let db: ReturnType<typeof createFakeDatabase>

/** 配信中の区切りを1件作る。ended_at が NULL なら配信中である */
const startStream = (id: string, startedAt = STREAM_START): void => {
  db.sqlite
    .prepare('INSERT INTO stream_sessions (id, started_at, title, category_name) VALUES (?, ?, ?, ?)')
    .run(id, new Date(startedAt).toISOString(), '雑談配信', 'Just Chatting')
}

/** 配信中の区切りをすべて閉じる */
const endStream = (endedAt: number): void => {
  db.sqlite.prepare('UPDATE stream_sessions SET ended_at = ? WHERE ended_at IS NULL').run(new Date(endedAt).toISOString())
}

const countRows = (): number =>
  (db.sqlite.prepare('SELECT COUNT(*) AS count FROM transcripts').get() as { count: number }).count

beforeEach(() => {
  db = createFakeDatabase()
})

describe('recordTranscript', () => {
  it('配信中の発話を、そのときの配信の区切りに結びつけて記録する', async () => {
    startStream('配信1')

    expect(await recordTranscript(db, { messageId: '発話1', text: 'こんばんは、配信を始めます' }, speechTime)).toBe(true)

    expect(db.sqlite.prepare('SELECT message_id, session_id, spoken_at, text FROM transcripts').all()).toEqual([
      {
        message_id: '発話1',
        session_id: '配信1',
        spoken_at: '2026-09-23T20:05:00.000Z',
        text: 'こんばんは、配信を始めます',
      },
    ])
  })

  it('配信していないときの発話は記録しない', async () => {
    expect(await recordTranscript(db, { messageId: '独り言', text: 'マイクの確認です' }, speechTime)).toBe(false)
    expect(countRows()).toBe(0)
  })

  it('配信が終わったあとの発話は記録しない', async () => {
    startStream('配信1')
    endStream(Date.parse('2026-09-23T20:04:00.000Z'))

    expect(await recordTranscript(db, { messageId: '配信後の独り言', text: 'おつかれさまでした' }, speechTime)).toBe(false)
    expect(countRows()).toBe(0)
  })

  it('同じメッセージIDが二度届いても行が増えず、どちらも記録したと答える', async () => {
    startStream('配信1')

    expect(await recordTranscript(db, { messageId: '発話1', text: 'こんばんは' }, speechTime)).toBe(true)
    expect(await recordTranscript(db, { messageId: '発話1', text: 'こんばんは' }, speechTime + 1000)).toBe(true)

    expect(countRows()).toBe(1)
    expect(db.sqlite.prepare('SELECT spoken_at FROM transcripts').all()).toEqual([{ spoken_at: '2026-09-23T20:05:00.000Z' }])
  })
})

describe('readTranscriptsSince', () => {
  it('その配信の発話を、喋った順に、喋った時刻を添えて返す', async () => {
    startStream('配信1')
    await recordTranscript(db, { messageId: '発話2', text: '二番目' }, speechTime + 1000)
    await recordTranscript(db, { messageId: '発話1', text: '一番目' }, speechTime)

    expect(await readTranscriptsSince(db, '配信1', { at: '', messageId: '' }, 10)).toEqual([
      { text: '一番目', at: '2026-09-23T20:05:00.000Z', messageId: '発話1' },
      { text: '二番目', at: '2026-09-23T20:05:01.000Z', messageId: '発話2' },
    ])
  })

  it('前回のあらすじが材料にした時刻までの発話は返さない', async () => {
    startStream('配信1')
    await recordTranscript(db, { messageId: '発話1', text: '前回までに読んだ話' }, speechTime)
    await recordTranscript(db, { messageId: '発話2', text: 'まだ読んでいない話' }, speechTime + 1000)

    expect(await readTranscriptsSince(db, '配信1', { at: '2026-09-23T20:05:00.000Z', messageId: '発話1' }, 10)).toEqual([
      { text: 'まだ読んでいない話', at: '2026-09-23T20:05:01.000Z', messageId: '発話2' },
    ])
  })

  it('ほかの配信の発話は混ぜない', async () => {
    startStream('配信1')
    await recordTranscript(db, { messageId: '発話1', text: '前の配信の話' }, speechTime)
    endStream(speechTime + 1000)
    startStream('配信2', speechTime + 2000)
    await recordTranscript(db, { messageId: '発話2', text: '今の配信の話' }, speechTime + 3000)

    expect(await readTranscriptsSince(db, '配信2', { at: '', messageId: '' }, 10)).toEqual([{ text: '今の配信の話', at: '2026-09-23T20:05:03.000Z', messageId: '発話2' }])
  })

  it('同じ時刻の発話の途中で上限に当たっても、残りは次に読める（取りこぼさない）', async () => {
    startStream('配信1')
    // ゆかコネNEO からの押し込みが立て続けに届くと、記録する時刻（Workerが受け取った時刻）が同じになりうる
    await recordTranscript(db, { messageId: '発話A', text: '同時刻の一件目' }, speechTime)
    await recordTranscript(db, { messageId: '発話B', text: '同時刻の二件目' }, speechTime)

    const firstAttempt = await readTranscriptsSince(db, '配信1', { at: '', messageId: '' }, 1)
    expect(firstAttempt).toEqual([{ text: '同時刻の一件目', at: '2026-09-23T20:05:00.000Z', messageId: '発話A' }])

    expect(await readTranscriptsSince(db, '配信1', firstAttempt.at(-1)!, 10)).toEqual([
      { text: '同時刻の二件目', at: '2026-09-23T20:05:00.000Z', messageId: '発話B' },
    ])
  })

  it('件数の上限を超えたぶんは、新しいほうを切る（次に作るときへ回す）', async () => {
    startStream('配信1')
    await recordTranscript(db, { messageId: '発話1', text: '一番目' }, speechTime)
    await recordTranscript(db, { messageId: '発話2', text: '二番目' }, speechTime + 1000)

    expect(await readTranscriptsSince(db, '配信1', { at: '', messageId: '' }, 1)).toEqual([{ text: '一番目', at: '2026-09-23T20:05:00.000Z', messageId: '発話1' }])
  })
})

describe('deleteOldTranscripts', () => {
  it('期限より古い発話を消す', async () => {
    startStream('配信1')
    await recordTranscript(db, { messageId: '古い発話', text: '昨日の話' }, speechTime)
    endStream(speechTime + 1000)

    await deleteOldTranscripts(db, speechTime + 2000)

    expect(countRows()).toBe(0)
  })

  it('期限より新しい発話は残す', async () => {
    startStream('配信1')
    await recordTranscript(db, { messageId: '新しい発話', text: 'さっきの話' }, speechTime)
    endStream(speechTime + 1000)

    await deleteOldTranscripts(db, speechTime - 1000)

    expect(countRows()).toBe(1)
  })

  it('配信中の区切りの発話は、期限より古くても消さない', async () => {
    startStream('配信1')
    await recordTranscript(db, { messageId: '耐久配信の序盤', text: 'はじめます' }, speechTime)

    await deleteOldTranscripts(db, speechTime + 2000)

    expect(countRows()).toBe(1)
  })
})

describe('readRecentTranscripts', () => {
  it('その配信の直近の発話を、喋った順（古い順）に、喋った時刻を添えて返す', async () => {
    startStream('配信1')
    await recordTranscript(db, { messageId: '発話1', text: '一番目' }, speechTime)
    await recordTranscript(db, { messageId: '発話2', text: '二番目' }, speechTime + 1000)

    expect(await readRecentTranscripts(db, '配信1', 10)).toEqual([
      { text: '一番目', at: '2026-09-23T20:05:00.000Z', messageId: '発話1' },
      { text: '二番目', at: '2026-09-23T20:05:01.000Z', messageId: '発話2' },
    ])
  })

  it('上限を超えたぶんは古いほうから落とす（サイドスーパーは直近の話題から作るため）', async () => {
    startStream('配信1')
    await recordTranscript(db, { messageId: '発話1', text: '古い話' }, speechTime)
    await recordTranscript(db, { messageId: '発話2', text: '少し前の話' }, speechTime + 1000)
    await recordTranscript(db, { messageId: '発話3', text: 'いまの話' }, speechTime + 2000)

    expect((await readRecentTranscripts(db, '配信1', 2)).map((line) => line.text)).toEqual(['少し前の話', 'いまの話'])
  })

  it('ほかの配信の発話は混ぜない', async () => {
    startStream('配信1')
    await recordTranscript(db, { messageId: '発話1', text: '前の配信の話' }, speechTime)
    endStream(speechTime + 1000)
    startStream('配信2', speechTime + 2000)
    await recordTranscript(db, { messageId: '発話2', text: '今の配信の話' }, speechTime + 3000)

    expect((await readRecentTranscripts(db, '配信2', 10)).map((line) => line.text)).toEqual(['今の配信の話'])
  })
})
