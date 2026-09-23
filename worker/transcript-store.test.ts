import { beforeEach, describe, expect, it } from 'vitest'
import { createFakeDatabase } from './fake-database'
import { deleteOldTranscripts, deleteTranscript, readTranscripts, recordTranscript } from './transcript-store'

const 配信開始 = Date.parse('2026-09-23T20:00:00.000Z')
const 発話時刻 = Date.parse('2026-09-23T20:05:00.000Z')

let db: ReturnType<typeof createFakeDatabase>

/** 配信中の区切りを1件作る。ended_at が NULL なら配信中である */
const 配信を始める = (id: string, startedAt = 配信開始): void => {
  db.sqlite
    .prepare('INSERT INTO stream_sessions (id, started_at, title, category_name) VALUES (?, ?, ?, ?)')
    .run(id, new Date(startedAt).toISOString(), '雑談配信', 'Just Chatting')
}

/** 配信中の区切りをすべて閉じる */
const 配信を終える = (endedAt: number): void => {
  db.sqlite.prepare('UPDATE stream_sessions SET ended_at = ? WHERE ended_at IS NULL').run(new Date(endedAt).toISOString())
}

const 行を数える = (): number =>
  (db.sqlite.prepare('SELECT COUNT(*) AS count FROM transcripts').get() as { count: number }).count

beforeEach(() => {
  db = createFakeDatabase()
})

describe('recordTranscript', () => {
  it('配信中の発話を、そのときの配信の区切りに結びつけて記録する', async () => {
    配信を始める('配信1')

    expect(await recordTranscript(db, { messageId: '発話1', text: 'こんばんは、配信を始めます' }, 発話時刻)).toBe(true)

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
    expect(await recordTranscript(db, { messageId: '独り言', text: 'マイクの確認です' }, 発話時刻)).toBe(false)
    expect(行を数える()).toBe(0)
  })

  it('配信が終わったあとの発話は記録しない', async () => {
    配信を始める('配信1')
    配信を終える(Date.parse('2026-09-23T20:04:00.000Z'))

    expect(await recordTranscript(db, { messageId: '配信後の独り言', text: 'おつかれさまでした' }, 発話時刻)).toBe(false)
    expect(行を数える()).toBe(0)
  })

  it('同じメッセージIDが二度届いても行が増えず、どちらも記録したと答える', async () => {
    配信を始める('配信1')

    expect(await recordTranscript(db, { messageId: '発話1', text: 'こんばんは' }, 発話時刻)).toBe(true)
    expect(await recordTranscript(db, { messageId: '発話1', text: 'こんばんは' }, 発話時刻 + 1000)).toBe(true)

    expect(行を数える()).toBe(1)
    expect(db.sqlite.prepare('SELECT spoken_at FROM transcripts').all()).toEqual([{ spoken_at: '2026-09-23T20:05:00.000Z' }])
  })
})

describe('deleteTranscript', () => {
  it('記録済みの発話を取り消す', async () => {
    配信を始める('配信1')
    await recordTranscript(db, { messageId: '言い間違い', text: 'えーと' }, 発話時刻)

    expect(await deleteTranscript(db, '言い間違い')).toBe(true)
    expect(行を数える()).toBe(0)
  })

  it('記録の無い発話の取り消しは、消したと答えない', async () => {
    expect(await deleteTranscript(db, '知らない発話')).toBe(false)
  })
})

describe('readTranscripts', () => {
  it('その配信の発話を、喋った順に返す', async () => {
    配信を始める('配信1')
    await recordTranscript(db, { messageId: '発話2', text: '二番目' }, 発話時刻 + 1000)
    await recordTranscript(db, { messageId: '発話1', text: '一番目' }, 発話時刻)

    expect(await readTranscripts(db, '配信1', 10)).toEqual(['一番目', '二番目'])
  })

  it('ほかの配信の発話は混ぜない', async () => {
    配信を始める('配信1')
    await recordTranscript(db, { messageId: '発話1', text: '前の配信の話' }, 発話時刻)
    配信を終える(発話時刻 + 1000)
    配信を始める('配信2', 発話時刻 + 2000)
    await recordTranscript(db, { messageId: '発話2', text: '今の配信の話' }, 発話時刻 + 3000)

    expect(await readTranscripts(db, '配信2', 10)).toEqual(['今の配信の話'])
  })

  it('件数の上限を超えたぶんは、新しいほうを切る', async () => {
    配信を始める('配信1')
    await recordTranscript(db, { messageId: '発話1', text: '一番目' }, 発話時刻)
    await recordTranscript(db, { messageId: '発話2', text: '二番目' }, 発話時刻 + 1000)

    expect(await readTranscripts(db, '配信1', 1)).toEqual(['一番目'])
  })
})

describe('deleteOldTranscripts', () => {
  it('期限より古い発話を消す', async () => {
    配信を始める('配信1')
    await recordTranscript(db, { messageId: '古い発話', text: '昨日の話' }, 発話時刻)
    配信を終える(発話時刻 + 1000)

    await deleteOldTranscripts(db, 発話時刻 + 2000)

    expect(行を数える()).toBe(0)
  })

  it('期限より新しい発話は残す', async () => {
    配信を始める('配信1')
    await recordTranscript(db, { messageId: '新しい発話', text: 'さっきの話' }, 発話時刻)
    配信を終える(発話時刻 + 1000)

    await deleteOldTranscripts(db, 発話時刻 - 1000)

    expect(行を数える()).toBe(1)
  })

  it('配信中の区切りの発話は、期限より古くても消さない', async () => {
    配信を始める('配信1')
    await recordTranscript(db, { messageId: '耐久配信の序盤', text: 'はじめます' }, 発話時刻)

    await deleteOldTranscripts(db, 発話時刻 + 2000)

    expect(行を数える()).toBe(1)
  })
})
