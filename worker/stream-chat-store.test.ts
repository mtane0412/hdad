/**
 * 人物像の材料になるチャットの一時的な記録（stream-chat-store.ts）のテスト
 *
 * メモリ上のSQLite（fake-database.ts）に migrations/ を適用して確かめる。特に重要なのは次の3点。
 * - 配信中に届いた発言だけを貯め、配信していないときは1行も書かないこと
 * - 同じ通知が再送されても、同じ発言を二重に貯めないこと
 * - 人物像を作る対象として返すのは、終わった配信の発言だけであること（配信中の発言はまだ材料にしない）
 */
import { describe, expect, it } from 'vitest'
import { createFakeDatabase } from './fake-database'
import { deleteOldStreamChatMessages, deleteStreamChatMessages, listSummaryTargets, readRecentSessionChat, readSessionChatSince, readViewerMessages, recordStreamChatMessage } from './stream-chat-store'
import { recordStreamOffline, recordStreamOnline } from './stats-store'

const STREAM_START = Date.UTC(2026, 8, 21, 12, 0, 0)
const ONE_MINUTE = 60 * 1000

const createChat = (overrides: Partial<Parameters<typeof recordStreamChatMessage>[1]> = {}) => ({
  messageId: 'chat-message-1',
  userId: '100',
  text: 'こんばんは！',
  ...overrides,
})

/** 配信中の区切りを1つ作る */
const startStream = async (db: ReturnType<typeof createFakeDatabase>) => {
  await recordStreamOnline(db, { id: 'stream-1', startedAt: STREAM_START })
}

/** 配信を終え、その配信を終わりまで章にし終えた状態にする（人物像の材料になるのは、この状態の配信の発言だけである） */
const endStreamAndChapter = async (db: ReturnType<typeof createFakeDatabase>, endedAt: number) => {
  await recordStreamOffline(db, endedAt)
  db.sqlite.prepare('UPDATE stream_sessions SET chaptered_until = ended_at').run()
}

describe('recordStreamChatMessage', () => {
  it('配信中に届いた発言を、その配信の区切りに結びつけて貯める', async () => {
    const db = createFakeDatabase()
    await startStream(db)

    await recordStreamChatMessage(db, createChat(), STREAM_START + ONE_MINUTE)

    const rows = db.sqlite.prepare('SELECT session_id, user_id, sent_at, text FROM stream_chat_messages').all()
    expect(rows).toEqual([{ session_id: 'stream-1', user_id: '100', sent_at: '2026-09-21T12:01:00.000Z', text: 'こんばんは！' }])
  })

  it('配信していないときは1行も貯めない', async () => {
    const db = createFakeDatabase()

    await recordStreamChatMessage(db, createChat(), STREAM_START + ONE_MINUTE)

    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_chat_messages').get()).toEqual({ count: 0 })
  })

  it('同じ通知が再送されても、同じ発言を二重に貯めない', async () => {
    const db = createFakeDatabase()
    await startStream(db)

    await recordStreamChatMessage(db, createChat(), STREAM_START + ONE_MINUTE)
    await recordStreamChatMessage(db, createChat(), STREAM_START + 2 * ONE_MINUTE)

    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_chat_messages').get()).toEqual({ count: 1 })
  })
})

describe('listSummaryTargets', () => {
  it('終わった配信で発言した人を、発言の多い順に返す', async () => {
    const db = createFakeDatabase()
    await startStream(db)
    await recordStreamChatMessage(db, createChat({ messageId: 'm1', userId: '100' }), STREAM_START + ONE_MINUTE)
    await recordStreamChatMessage(db, createChat({ messageId: 'm2', userId: '200' }), STREAM_START + ONE_MINUTE)
    await recordStreamChatMessage(db, createChat({ messageId: 'm3', userId: '200' }), STREAM_START + 2 * ONE_MINUTE)
    await endStreamAndChapter(db, STREAM_START + 3 * ONE_MINUTE)

    expect(await listSummaryTargets(db, 10)).toEqual([
      { userId: '200', messageCount: 2 },
      { userId: '100', messageCount: 1 },
    ])
  })

  it('配信中の発言は、まだ材料にしない', async () => {
    const db = createFakeDatabase()
    await startStream(db)
    await recordStreamChatMessage(db, createChat(), STREAM_START + ONE_MINUTE)

    expect(await listSummaryTargets(db, 10)).toEqual([])
  })

  it('終わった配信でも、終わりまで章にし終えるまでは材料にしない（人物像を作ると発言が消え、最後の章から視聴者の反応が抜けるため）', async () => {
    const db = createFakeDatabase()
    await startStream(db)
    await recordStreamChatMessage(db, createChat(), STREAM_START + ONE_MINUTE)
    // 配信は終わったが、章立てはまだ配信の途中までしか進んでいない
    await recordStreamOffline(db, STREAM_START + 3 * ONE_MINUTE)
    db.sqlite.prepare('UPDATE stream_sessions SET chaptered_until = ?').run(new Date(STREAM_START + 2 * ONE_MINUTE).toISOString())

    expect(await listSummaryTargets(db, 10)).toEqual([])
    expect(await readViewerMessages(db, '100', 10)).toEqual([])
  })

  it('一度に返す人数を、渡された上限までに抑える', async () => {
    const db = createFakeDatabase()
    await startStream(db)
    await recordStreamChatMessage(db, createChat({ messageId: 'm1', userId: '100' }), STREAM_START + ONE_MINUTE)
    await recordStreamChatMessage(db, createChat({ messageId: 'm2', userId: '200' }), STREAM_START + ONE_MINUTE)
    await endStreamAndChapter(db, STREAM_START + 3 * ONE_MINUTE)

    expect(await listSummaryTargets(db, 1)).toHaveLength(1)
  })
})

describe('readViewerMessages', () => {
  it('その人の発言を、終わった配信のぶんだけ古い順に返す', async () => {
    const db = createFakeDatabase()
    await startStream(db)
    await recordStreamChatMessage(db, createChat({ messageId: 'm1', text: 'こんばんは' }), STREAM_START + ONE_MINUTE)
    await recordStreamChatMessage(db, createChat({ messageId: 'm2', text: 'ギターいいですね' }), STREAM_START + 2 * ONE_MINUTE)
    await endStreamAndChapter(db, STREAM_START + 3 * ONE_MINUTE)

    expect(await readViewerMessages(db, '100', 10)).toEqual(['こんばんは', 'ギターいいですね'])
  })

  it('読む件数を、渡された上限までに抑える', async () => {
    const db = createFakeDatabase()
    await startStream(db)
    await recordStreamChatMessage(db, createChat({ messageId: 'm1', text: '1つめ' }), STREAM_START + ONE_MINUTE)
    await recordStreamChatMessage(db, createChat({ messageId: 'm2', text: '2つめ' }), STREAM_START + 2 * ONE_MINUTE)
    await endStreamAndChapter(db, STREAM_START + 3 * ONE_MINUTE)

    expect(await readViewerMessages(db, '100', 1)).toEqual(['1つめ'])
  })
})

describe('deleteStreamChatMessages', () => {
  it('その人の、終わった配信のぶんの材料だけを消す', async () => {
    const db = createFakeDatabase()
    await startStream(db)
    await recordStreamChatMessage(db, createChat({ messageId: 'm1', userId: '100' }), STREAM_START + ONE_MINUTE)
    await recordStreamChatMessage(db, createChat({ messageId: 'm2', userId: '200' }), STREAM_START + ONE_MINUTE)
    await endStreamAndChapter(db, STREAM_START + 3 * ONE_MINUTE)

    await deleteStreamChatMessages(db, '100')

    expect(await listSummaryTargets(db, 10)).toEqual([{ userId: '200', messageCount: 1 }])
  })

  it('終わりまで章にし終えていない配信の発言は消さない（最後の章の材料になる）', async () => {
    const db = createFakeDatabase()
    await startStream(db)
    await recordStreamChatMessage(db, createChat({ messageId: 'm1', userId: '100' }), STREAM_START + ONE_MINUTE)
    await recordStreamOffline(db, STREAM_START + 3 * ONE_MINUTE)

    await deleteStreamChatMessages(db, '100')

    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_chat_messages').get()).toEqual({ count: 1 })
  })

  it('配信中の発言は消さない（その配信が終わったあとの材料になる）', async () => {
    const db = createFakeDatabase()
    await startStream(db)
    await recordStreamChatMessage(db, createChat({ messageId: 'm1', userId: '100' }), STREAM_START + ONE_MINUTE)

    await deleteStreamChatMessages(db, '100')

    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_chat_messages').get()).toEqual({ count: 1 })
  })
})

describe('deleteOldStreamChatMessages', () => {
  it('渡された日時より前の発言を消す', async () => {
    const db = createFakeDatabase()
    await startStream(db)
    await recordStreamChatMessage(db, createChat({ messageId: 'm1' }), STREAM_START + ONE_MINUTE)
    await recordStreamChatMessage(db, createChat({ messageId: 'm2' }), STREAM_START + 10 * ONE_MINUTE)

    await deleteOldStreamChatMessages(db, STREAM_START + 5 * ONE_MINUTE)

    expect(db.sqlite.prepare('SELECT message_id FROM stream_chat_messages').all()).toEqual([{ message_id: 'm2' }])
  })
})

describe('readSessionChatSince', () => {
  it('その配信の発言を、届いた順に、届いた時刻を添えて返す', async () => {
    const db = createFakeDatabase()
    await startStream(db)
    await recordStreamChatMessage(db, createChat({ messageId: '発言2', text: 'がんばってー' }), STREAM_START + ONE_MINUTE * 2)
    await recordStreamChatMessage(db, createChat({ messageId: '発言1', text: 'こんばんは！' }), STREAM_START + ONE_MINUTE)

    expect(await readSessionChatSince(db, 'stream-1', { at: '', messageId: '' }, 10)).toEqual([
      { text: 'こんばんは！', at: new Date(STREAM_START + ONE_MINUTE).toISOString(), messageId: '発言1' },
      { text: 'がんばってー', at: new Date(STREAM_START + ONE_MINUTE * 2).toISOString(), messageId: '発言2' },
    ])
  })

  it('前回のあらすじが材料にした時刻までの発言は返さない', async () => {
    const db = createFakeDatabase()
    await startStream(db)
    await recordStreamChatMessage(db, createChat({ messageId: '発言1', text: '前回までに読んだ発言' }), STREAM_START + ONE_MINUTE)
    await recordStreamChatMessage(db, createChat({ messageId: '発言2', text: 'まだ読んでいない発言' }), STREAM_START + ONE_MINUTE * 2)

    expect(await readSessionChatSince(db, 'stream-1', { at: new Date(STREAM_START + ONE_MINUTE).toISOString(), messageId: '発言1' }, 10)).toEqual([
      { text: 'まだ読んでいない発言', at: new Date(STREAM_START + ONE_MINUTE * 2).toISOString(), messageId: '発言2' },
    ])
  })

  it('件数の上限を超えたぶんは、新しいほうを切る（次に作るときへ回す）', async () => {
    const db = createFakeDatabase()
    await startStream(db)
    await recordStreamChatMessage(db, createChat({ messageId: '発言1', text: '一番目' }), STREAM_START + ONE_MINUTE)
    await recordStreamChatMessage(db, createChat({ messageId: '発言2', text: '二番目' }), STREAM_START + ONE_MINUTE * 2)

    expect(await readSessionChatSince(db, 'stream-1', { at: '', messageId: '' }, 1)).toEqual([{ text: '一番目', at: new Date(STREAM_START + ONE_MINUTE).toISOString(), messageId: '発言1' }])
  })
})

describe('readSessionChatSince の取りこぼし', () => {
  it('同じ時刻の発言の途中で上限に当たっても、残りは次に読める', async () => {
    const db = createFakeDatabase()
    await startStream(db)
    // 立て続けに届いた通知は、記録する時刻（Workerが受け取った時刻）が同じになりうる
    await recordStreamChatMessage(db, createChat({ messageId: '発言A', text: '同時刻の一件目' }), STREAM_START + ONE_MINUTE)
    await recordStreamChatMessage(db, createChat({ messageId: '発言B', text: '同時刻の二件目' }), STREAM_START + ONE_MINUTE)

    const first = await readSessionChatSince(db, 'stream-1', { at: '', messageId: '' }, 1)
    expect(first).toEqual([{ text: '同時刻の一件目', at: new Date(STREAM_START + ONE_MINUTE).toISOString(), messageId: '発言A' }])

    expect(await readSessionChatSince(db, 'stream-1', first.at(-1)!, 10)).toEqual([
      { text: '同時刻の二件目', at: new Date(STREAM_START + ONE_MINUTE).toISOString(), messageId: '発言B' },
    ])
  })
})

describe('readRecentSessionChat', () => {
  it('その配信の直近の発言を、届いた順（古い順）に、届いた時刻を添えて返す', async () => {
    const db = createFakeDatabase()
    await startStream(db)
    await recordStreamChatMessage(db, createChat({ messageId: '発言1', text: 'こんばんは！' }), STREAM_START + ONE_MINUTE)
    await recordStreamChatMessage(db, createChat({ messageId: '発言2', text: 'がんばってー' }), STREAM_START + ONE_MINUTE * 2)

    expect(await readRecentSessionChat(db, 'stream-1', 10)).toEqual([
      { text: 'こんばんは！', at: new Date(STREAM_START + ONE_MINUTE).toISOString(), messageId: '発言1' },
      { text: 'がんばってー', at: new Date(STREAM_START + ONE_MINUTE * 2).toISOString(), messageId: '発言2' },
    ])
  })

  it('上限を超えたぶんは古いほうから落とす（サイドスーパーは直近の話題から作るため）', async () => {
    const db = createFakeDatabase()
    await startStream(db)
    await recordStreamChatMessage(db, createChat({ messageId: '発言1', text: '古い反応' }), STREAM_START + ONE_MINUTE)
    await recordStreamChatMessage(db, createChat({ messageId: '発言2', text: '少し前の反応' }), STREAM_START + ONE_MINUTE * 2)
    await recordStreamChatMessage(db, createChat({ messageId: '発言3', text: 'いまの反応' }), STREAM_START + ONE_MINUTE * 3)

    expect((await readRecentSessionChat(db, 'stream-1', 2)).map((line) => line.text)).toEqual(['少し前の反応', 'いまの反応'])
  })

  it('ほかの配信の発言は混ぜない', async () => {
    const db = createFakeDatabase()
    await startStream(db)
    await recordStreamChatMessage(db, createChat({ messageId: '発言1', text: '前の配信の反応' }), STREAM_START + ONE_MINUTE)
    await recordStreamOffline(db, STREAM_START + ONE_MINUTE * 2)
    await recordStreamOnline(db, { id: 'stream-2', startedAt: STREAM_START + ONE_MINUTE * 3 })
    await recordStreamChatMessage(db, createChat({ messageId: '発言2', text: '今の配信の反応' }), STREAM_START + ONE_MINUTE * 4)

    expect((await readRecentSessionChat(db, 'stream-2', 10)).map((line) => line.text)).toEqual(['今の配信の反応'])
  })
})
