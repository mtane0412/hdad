import { beforeEach, describe, expect, it } from 'vitest'
import { createFakeDatabase } from './fake-database'
import { readCurrentStreamSummary, readStreamSummary, saveStreamSummary } from './stream-summary-store'

const 作成時刻 = Date.parse('2026-09-23T20:10:00.000Z')

let db: ReturnType<typeof createFakeDatabase>

/** 配信中の区切りを1件作る */
const 配信を始める = (id: string, startedAt = Date.parse('2026-09-23T20:00:00.000Z')): void => {
  db.sqlite
    .prepare('INSERT INTO stream_sessions (id, started_at, title, category_name) VALUES (?, ?, ?, ?)')
    .run(id, new Date(startedAt).toISOString(), '雑談配信', 'Just Chatting')
}

/** 配信中の区切りをすべて閉じる */
const 配信を終える = (endedAt: number): void => {
  db.sqlite.prepare('UPDATE stream_sessions SET ended_at = ? WHERE ended_at IS NULL').run(new Date(endedAt).toISOString())
}

beforeEach(() => {
  db = createFakeDatabase()
})

describe('readStreamSummary', () => {
  it('まだ作っていない配信では null を返す', async () => {
    expect(await readStreamSummary(db, '配信1')).toBeNull()
  })

  it('保存したあらすじと、どこまでを材料にしたかを返す', async () => {
    await saveStreamSummary(
      db,
      {
        sessionId: '配信1',
        summary: '新しいゲームの導入部を遊んでいます',
        transcriptsUntil: { at: '2026-09-23T20:09:00.000Z', messageId: '発話9' },
        chatUntil: { at: '2026-09-23T20:08:30.000Z', messageId: '発言8' },
      },
      作成時刻,
    )

    expect(await readStreamSummary(db, '配信1')).toEqual({
      summary: '新しいゲームの導入部を遊んでいます',
      transcriptsUntil: { at: '2026-09-23T20:09:00.000Z', messageId: '発話9' },
      chatUntil: { at: '2026-09-23T20:08:30.000Z', messageId: '発言8' },
      updatedAt: '2026-09-23T20:10:00.000Z',
    })
  })
})

describe('saveStreamSummary', () => {
  it('同じ配信で二度保存すると、行が増えずに書き換わる', async () => {
    await saveStreamSummary(
      db,
      { sessionId: '配信1', summary: '導入部を遊んでいます', transcriptsUntil: { at: '2026-09-23T20:09:00.000Z', messageId: '発話9' }, chatUntil: { at: '', messageId: '' } },
      作成時刻,
    )
    await saveStreamSummary(
      db,
      { sessionId: '配信1', summary: '2つめの街に着きました', transcriptsUntil: { at: '2026-09-23T20:14:00.000Z', messageId: '発話14' }, chatUntil: { at: '', messageId: '' } },
      Date.parse('2026-09-23T20:15:00.000Z'),
    )

    expect((db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_summaries').get() as { count: number }).count).toBe(1)
    expect(await readStreamSummary(db, '配信1')).toEqual({
      summary: '2つめの街に着きました',
      transcriptsUntil: { at: '2026-09-23T20:14:00.000Z', messageId: '発話14' },
      chatUntil: { at: '', messageId: '' },
      updatedAt: '2026-09-23T20:15:00.000Z',
    })
  })

  it('配信ごとに別の行として持つので、前の配信のあらすじは残ったまま混ざらない', async () => {
    await saveStreamSummary(db, { sessionId: '配信1', summary: '前の配信の話', transcriptsUntil: { at: '', messageId: '' }, chatUntil: { at: '', messageId: '' } }, 作成時刻)
    await saveStreamSummary(db, { sessionId: '配信2', summary: '今日の配信の話', transcriptsUntil: { at: '', messageId: '' }, chatUntil: { at: '', messageId: '' } }, 作成時刻)

    expect((await readStreamSummary(db, '配信1'))?.summary).toBe('前の配信の話')
    expect((await readStreamSummary(db, '配信2'))?.summary).toBe('今日の配信の話')
  })
})

describe('readCurrentStreamSummary', () => {
  it('いま進んでいる配信のあらすじを返す', async () => {
    配信を始める('配信1')
    await saveStreamSummary(db, { sessionId: '配信1', summary: '導入部を遊んでいます', transcriptsUntil: { at: '', messageId: '' }, chatUntil: { at: '', messageId: '' } }, 作成時刻)

    expect(await readCurrentStreamSummary(db, 作成時刻)).toEqual({ summary: '導入部を遊んでいます', updatedAt: '2026-09-23T20:10:00.000Z' })
  })

  it('配信していなければ null を返す（前の配信のあらすじを持ち越さない）', async () => {
    配信を始める('配信1')
    await saveStreamSummary(db, { sessionId: '配信1', summary: '前の配信の話', transcriptsUntil: { at: '', messageId: '' }, chatUntil: { at: '', messageId: '' } }, 作成時刻)
    配信を終える(作成時刻 + 1000)

    expect(await readCurrentStreamSummary(db, 作成時刻 + 2000)).toBeNull()
  })

  it('配信は始まっているが、まだあらすじを作っていなければ null を返す', async () => {
    配信を始める('配信1')

    expect(await readCurrentStreamSummary(db, 作成時刻)).toBeNull()
  })
})
