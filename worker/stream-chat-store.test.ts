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

const 配信開始 = Date.UTC(2026, 8, 21, 12, 0, 0)
const 一分 = 60 * 1000

const 発言 = (上書き: Partial<Parameters<typeof recordStreamChatMessage>[1]> = {}) => ({
  messageId: 'chat-message-1',
  userId: '100',
  text: 'こんばんは！',
  ...上書き,
})

/** 配信中の区切りを1つ作る */
const 配信を始める = async (db: ReturnType<typeof createFakeDatabase>) => {
  await recordStreamOnline(db, { id: 'stream-1', startedAt: 配信開始 })
}

describe('recordStreamChatMessage', () => {
  it('配信中に届いた発言を、その配信の区切りに結びつけて貯める', async () => {
    const db = createFakeDatabase()
    await 配信を始める(db)

    await recordStreamChatMessage(db, 発言(), 配信開始 + 一分)

    const rows = db.sqlite.prepare('SELECT session_id, user_id, sent_at, text FROM stream_chat_messages').all()
    expect(rows).toEqual([{ session_id: 'stream-1', user_id: '100', sent_at: '2026-09-21T12:01:00.000Z', text: 'こんばんは！' }])
  })

  it('配信していないときは1行も貯めない', async () => {
    const db = createFakeDatabase()

    await recordStreamChatMessage(db, 発言(), 配信開始 + 一分)

    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_chat_messages').get()).toEqual({ count: 0 })
  })

  it('同じ通知が再送されても、同じ発言を二重に貯めない', async () => {
    const db = createFakeDatabase()
    await 配信を始める(db)

    await recordStreamChatMessage(db, 発言(), 配信開始 + 一分)
    await recordStreamChatMessage(db, 発言(), 配信開始 + 2 * 一分)

    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_chat_messages').get()).toEqual({ count: 1 })
  })
})

describe('listSummaryTargets', () => {
  it('終わった配信で発言した人を、発言の多い順に返す', async () => {
    const db = createFakeDatabase()
    await 配信を始める(db)
    await recordStreamChatMessage(db, 発言({ messageId: 'm1', userId: '100' }), 配信開始 + 一分)
    await recordStreamChatMessage(db, 発言({ messageId: 'm2', userId: '200' }), 配信開始 + 一分)
    await recordStreamChatMessage(db, 発言({ messageId: 'm3', userId: '200' }), 配信開始 + 2 * 一分)
    await recordStreamOffline(db, 配信開始 + 3 * 一分)

    expect(await listSummaryTargets(db, 10)).toEqual([
      { userId: '200', messageCount: 2 },
      { userId: '100', messageCount: 1 },
    ])
  })

  it('配信中の発言は、まだ材料にしない', async () => {
    const db = createFakeDatabase()
    await 配信を始める(db)
    await recordStreamChatMessage(db, 発言(), 配信開始 + 一分)

    expect(await listSummaryTargets(db, 10)).toEqual([])
  })

  it('一度に返す人数を、渡された上限までに抑える', async () => {
    const db = createFakeDatabase()
    await 配信を始める(db)
    await recordStreamChatMessage(db, 発言({ messageId: 'm1', userId: '100' }), 配信開始 + 一分)
    await recordStreamChatMessage(db, 発言({ messageId: 'm2', userId: '200' }), 配信開始 + 一分)
    await recordStreamOffline(db, 配信開始 + 3 * 一分)

    expect(await listSummaryTargets(db, 1)).toHaveLength(1)
  })
})

describe('readViewerMessages', () => {
  it('その人の発言を、終わった配信のぶんだけ古い順に返す', async () => {
    const db = createFakeDatabase()
    await 配信を始める(db)
    await recordStreamChatMessage(db, 発言({ messageId: 'm1', text: 'こんばんは' }), 配信開始 + 一分)
    await recordStreamChatMessage(db, 発言({ messageId: 'm2', text: 'ギターいいですね' }), 配信開始 + 2 * 一分)
    await recordStreamOffline(db, 配信開始 + 3 * 一分)

    expect(await readViewerMessages(db, '100', 10)).toEqual(['こんばんは', 'ギターいいですね'])
  })

  it('読む件数を、渡された上限までに抑える', async () => {
    const db = createFakeDatabase()
    await 配信を始める(db)
    await recordStreamChatMessage(db, 発言({ messageId: 'm1', text: '1つめ' }), 配信開始 + 一分)
    await recordStreamChatMessage(db, 発言({ messageId: 'm2', text: '2つめ' }), 配信開始 + 2 * 一分)
    await recordStreamOffline(db, 配信開始 + 3 * 一分)

    expect(await readViewerMessages(db, '100', 1)).toEqual(['1つめ'])
  })
})

describe('deleteStreamChatMessages', () => {
  it('その人の、終わった配信のぶんの材料だけを消す', async () => {
    const db = createFakeDatabase()
    await 配信を始める(db)
    await recordStreamChatMessage(db, 発言({ messageId: 'm1', userId: '100' }), 配信開始 + 一分)
    await recordStreamChatMessage(db, 発言({ messageId: 'm2', userId: '200' }), 配信開始 + 一分)
    await recordStreamOffline(db, 配信開始 + 3 * 一分)

    await deleteStreamChatMessages(db, '100')

    expect(await listSummaryTargets(db, 10)).toEqual([{ userId: '200', messageCount: 1 }])
  })

  it('配信中の発言は消さない（その配信が終わったあとの材料になる）', async () => {
    const db = createFakeDatabase()
    await 配信を始める(db)
    await recordStreamChatMessage(db, 発言({ messageId: 'm1', userId: '100' }), 配信開始 + 一分)

    await deleteStreamChatMessages(db, '100')

    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_chat_messages').get()).toEqual({ count: 1 })
  })
})

describe('deleteOldStreamChatMessages', () => {
  it('渡された日時より前の発言を消す', async () => {
    const db = createFakeDatabase()
    await 配信を始める(db)
    await recordStreamChatMessage(db, 発言({ messageId: 'm1' }), 配信開始 + 一分)
    await recordStreamChatMessage(db, 発言({ messageId: 'm2' }), 配信開始 + 10 * 一分)

    await deleteOldStreamChatMessages(db, 配信開始 + 5 * 一分)

    expect(db.sqlite.prepare('SELECT message_id FROM stream_chat_messages').all()).toEqual([{ message_id: 'm2' }])
  })
})

describe('readSessionChatSince', () => {
  it('その配信の発言を、届いた順に、届いた時刻を添えて返す', async () => {
    const db = createFakeDatabase()
    await 配信を始める(db)
    await recordStreamChatMessage(db, 発言({ messageId: '発言2', text: 'がんばってー' }), 配信開始 + 一分 * 2)
    await recordStreamChatMessage(db, 発言({ messageId: '発言1', text: 'こんばんは！' }), 配信開始 + 一分)

    expect(await readSessionChatSince(db, 'stream-1', { at: '', messageId: '' }, 10)).toEqual([
      { text: 'こんばんは！', at: new Date(配信開始 + 一分).toISOString(), messageId: '発言1' },
      { text: 'がんばってー', at: new Date(配信開始 + 一分 * 2).toISOString(), messageId: '発言2' },
    ])
  })

  it('前回のあらすじが材料にした時刻までの発言は返さない', async () => {
    const db = createFakeDatabase()
    await 配信を始める(db)
    await recordStreamChatMessage(db, 発言({ messageId: '発言1', text: '前回までに読んだ発言' }), 配信開始 + 一分)
    await recordStreamChatMessage(db, 発言({ messageId: '発言2', text: 'まだ読んでいない発言' }), 配信開始 + 一分 * 2)

    expect(await readSessionChatSince(db, 'stream-1', { at: new Date(配信開始 + 一分).toISOString(), messageId: '発言1' }, 10)).toEqual([
      { text: 'まだ読んでいない発言', at: new Date(配信開始 + 一分 * 2).toISOString(), messageId: '発言2' },
    ])
  })

  it('件数の上限を超えたぶんは、新しいほうを切る（次に作るときへ回す）', async () => {
    const db = createFakeDatabase()
    await 配信を始める(db)
    await recordStreamChatMessage(db, 発言({ messageId: '発言1', text: '一番目' }), 配信開始 + 一分)
    await recordStreamChatMessage(db, 発言({ messageId: '発言2', text: '二番目' }), 配信開始 + 一分 * 2)

    expect(await readSessionChatSince(db, 'stream-1', { at: '', messageId: '' }, 1)).toEqual([{ text: '一番目', at: new Date(配信開始 + 一分).toISOString(), messageId: '発言1' }])
  })
})

describe('readSessionChatSince の取りこぼし', () => {
  it('同じ時刻の発言の途中で上限に当たっても、残りは次に読める', async () => {
    const db = createFakeDatabase()
    await 配信を始める(db)
    // 立て続けに届いた通知は、記録する時刻（Workerが受け取った時刻）が同じになりうる
    await recordStreamChatMessage(db, 発言({ messageId: '発言A', text: '同時刻の一件目' }), 配信開始 + 一分)
    await recordStreamChatMessage(db, 発言({ messageId: '発言B', text: '同時刻の二件目' }), 配信開始 + 一分)

    const 一度目 = await readSessionChatSince(db, 'stream-1', { at: '', messageId: '' }, 1)
    expect(一度目).toEqual([{ text: '同時刻の一件目', at: new Date(配信開始 + 一分).toISOString(), messageId: '発言A' }])

    expect(await readSessionChatSince(db, 'stream-1', 一度目.at(-1)!, 10)).toEqual([
      { text: '同時刻の二件目', at: new Date(配信開始 + 一分).toISOString(), messageId: '発言B' },
    ])
  })
})

describe('readRecentSessionChat', () => {
  it('その配信の直近の発言を、届いた順（古い順）に、届いた時刻を添えて返す', async () => {
    const db = createFakeDatabase()
    await 配信を始める(db)
    await recordStreamChatMessage(db, 発言({ messageId: '発言1', text: 'こんばんは！' }), 配信開始 + 一分)
    await recordStreamChatMessage(db, 発言({ messageId: '発言2', text: 'がんばってー' }), 配信開始 + 一分 * 2)

    expect(await readRecentSessionChat(db, 'stream-1', 10)).toEqual([
      { text: 'こんばんは！', at: new Date(配信開始 + 一分).toISOString(), messageId: '発言1' },
      { text: 'がんばってー', at: new Date(配信開始 + 一分 * 2).toISOString(), messageId: '発言2' },
    ])
  })

  it('上限を超えたぶんは古いほうから落とす（サイドスーパーは直近の話題から作るため）', async () => {
    const db = createFakeDatabase()
    await 配信を始める(db)
    await recordStreamChatMessage(db, 発言({ messageId: '発言1', text: '古い反応' }), 配信開始 + 一分)
    await recordStreamChatMessage(db, 発言({ messageId: '発言2', text: '少し前の反応' }), 配信開始 + 一分 * 2)
    await recordStreamChatMessage(db, 発言({ messageId: '発言3', text: 'いまの反応' }), 配信開始 + 一分 * 3)

    expect((await readRecentSessionChat(db, 'stream-1', 2)).map((line) => line.text)).toEqual(['少し前の反応', 'いまの反応'])
  })

  it('ほかの配信の発言は混ぜない', async () => {
    const db = createFakeDatabase()
    await 配信を始める(db)
    await recordStreamChatMessage(db, 発言({ messageId: '発言1', text: '前の配信の反応' }), 配信開始 + 一分)
    await recordStreamOffline(db, 配信開始 + 一分 * 2)
    await recordStreamOnline(db, { id: 'stream-2', startedAt: 配信開始 + 一分 * 3 })
    await recordStreamChatMessage(db, 発言({ messageId: '発言2', text: '今の配信の反応' }), 配信開始 + 一分 * 4)

    expect((await readRecentSessionChat(db, 'stream-2', 10)).map((line) => line.text)).toEqual(['今の配信の反応'])
  })
})
