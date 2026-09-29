/**
 * コメントの既読・未読の読み書き（comment-read-store.ts）のテスト
 *
 * コメントビューアーの発言1件ごとの既読・未読を、発言のIDで1行に持つ（comment_reads）。ここで確かめるのは次の点である。
 * - 既読にした・未読に戻したことを、誰が付けたか（手動か Jev か）と一緒に記録すること
 * - 同じ発言をもう一度付け替えると、行を増やさず上書きすること（最後に付けた状態だけが意味を持つため）
 * - 保持期間を過ぎた行を消せること（配信中の発言の本文と同じく、配信が終わったら要らない）
 * - Jev に判定させる候補として、いま進んでいる配信のまだ一度も付け替えていない視聴者の発言を読めること
 * - Jev が既読にするのは、まだ一度も付け替えていない発言だけであること（配信者が手で付けた状態を上書きしない）
 */
import { describe, expect, it } from 'vitest'
import { deleteOldCommentReads, markReadByJev, readUnreadChats, recordCommentRead, unmarkReadByJev } from './comment-read-store'
import { createFakeDatabase } from './fake-database'

const 配信中の時刻 = Date.parse('2026-09-29T12:00:00.000Z')

/** 記録された行をそのまま読む */
const 行を読む = (db: ReturnType<typeof createFakeDatabase>) =>
  db.sqlite.prepare('SELECT message_id, read, marked_by, updated_at FROM comment_reads ORDER BY message_id').all()

describe('recordCommentRead', () => {
  it('配信者が手で既読にしたことを記録する', async () => {
    const db = createFakeDatabase()

    await recordCommentRead(db, { messageId: 'たなかさんの初見の挨拶', read: true, by: 'manual' }, 配信中の時刻)

    expect(行を読む(db)).toEqual([{ message_id: 'たなかさんの初見の挨拶', read: 1, marked_by: 'manual', updated_at: '2026-09-29T12:00:00.000Z' }])
  })

  it('同じ発言を未読に戻すと、行を増やさず上書きする', async () => {
    const db = createFakeDatabase()
    await recordCommentRead(db, { messageId: 'すずきさんのBGMの質問', read: true, by: 'manual' }, 配信中の時刻)

    // 1分後に、配信者が「やっぱりまだ答えていない」と未読に戻した
    await recordCommentRead(db, { messageId: 'すずきさんのBGMの質問', read: false, by: 'manual' }, 配信中の時刻 + 60_000)

    expect(行を読む(db)).toEqual([{ message_id: 'すずきさんのBGMの質問', read: 0, marked_by: 'manual', updated_at: '2026-09-29T12:01:00.000Z' }])
  })

  it('Jev が付けた既読も、誰が付けたかを分けて記録する', async () => {
    const db = createFakeDatabase()

    await recordCommentRead(db, { messageId: 'こうさんの配信時間の質問', read: true, by: 'jev' }, 配信中の時刻)

    expect(行を読む(db)).toMatchObject([{ message_id: 'こうさんの配信時間の質問', read: 1, marked_by: 'jev' }])
  })
})

describe('deleteOldCommentReads', () => {
  it('指定した時刻より前に付けた行だけを消す', async () => {
    const db = createFakeDatabase()
    await recordCommentRead(db, { messageId: '先週の配信の発言', read: true, by: 'manual' }, 配信中の時刻 - 8 * 24 * 60 * 60 * 1000)
    await recordCommentRead(db, { messageId: '今日の配信の発言', read: true, by: 'manual' }, 配信中の時刻)

    await deleteOldCommentReads(db, 配信中の時刻 - 7 * 24 * 60 * 60 * 1000)

    expect(行を読む(db)).toMatchObject([{ message_id: '今日の配信の発言' }])
  })
})

/** いま進んでいる配信と、その配信の発言を用意する */
const 配信中の発言を用意する = () => {
  const db = createFakeDatabase()
  db.sqlite
    .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, ?, ?, ?)')
    .run('いまの配信', '2026-09-29T11:00:00.000Z', null, '雑談', 'Just Chatting')
  db.sqlite
    .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, ?, ?, ?)')
    .run('昨日の配信', '2026-09-28T11:00:00.000Z', '2026-09-28T13:00:00.000Z', '雑談', 'Just Chatting')
  const 視聴者 = (userId: string, name: string) =>
    db.sqlite
      .prepare(
        `INSERT INTO viewers (user_id, login, display_name, first_seen_at, last_seen_at, message_count, last_badges, last_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(userId, `login_${userId}`, name, '2026-09-01T00:00:00.000Z', '2026-09-29T12:00:00.000Z', 1, '[]', '')
  視聴者('111', 'たなか')
  視聴者('222', 'すずき')
  視聴者('999', '配信者')
  const 発言 = (messageId: string, sessionId: string, userId: string, sentAt: string, text: string) =>
    db.sqlite.prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)').run(messageId, sessionId, userId, sentAt, text)
  return { db, 発言 }
}

describe('readUnreadChats', () => {
  const 条件 = { broadcasterId: '999', since: Date.parse('2026-09-29T11:50:00.000Z'), limit: 20 }

  it('いま進んでいる配信の、まだ付け替えていない視聴者の発言を、古い順に名前付きで読む', async () => {
    const { db, 発言 } = 配信中の発言を用意する()
    発言('すずきさんの質問', 'いまの配信', '222', '2026-09-29T11:58:00.000Z', 'このBGMなんて曲？')
    発言('たなかさんの挨拶', 'いまの配信', '111', '2026-09-29T11:55:00.000Z', '初見です')

    expect(await readUnreadChats(db, 条件)).toEqual([
      { messageId: 'たなかさんの挨拶', name: 'たなか', text: '初見です' },
      { messageId: 'すずきさんの質問', name: 'すずき', text: 'このBGMなんて曲？' },
    ])
  })

  it('既読にした発言・手で未読に戻した発言は読まない（手で未読に戻したものを Jev が既読にし直さないため）', async () => {
    const { db, 発言 } = 配信中の発言を用意する()
    発言('既読にした発言', 'いまの配信', '111', '2026-09-29T11:55:00.000Z', '初見です')
    発言('未読に戻した発言', 'いまの配信', '222', '2026-09-29T11:56:00.000Z', 'このBGMなんて曲？')
    発言('まだの発言', 'いまの配信', '222', '2026-09-29T11:57:00.000Z', '何時まで配信？')
    await recordCommentRead(db, { messageId: '既読にした発言', read: true, by: 'manual' }, 配信中の時刻)
    await recordCommentRead(db, { messageId: '未読に戻した発言', read: false, by: 'manual' }, 配信中の時刻)

    expect((await readUnreadChats(db, 条件)).map((chat) => chat.messageId)).toEqual(['まだの発言'])
  })

  it('配信者自身の発言・終わった配信の発言・決めた時刻より前の発言は読まない', async () => {
    const { db, 発言 } = 配信中の発言を用意する()
    発言('配信者の発言', 'いまの配信', '999', '2026-09-29T11:55:00.000Z', 'みなさんこんばんは')
    発言('昨日の発言', '昨日の配信', '111', '2026-09-28T12:00:00.000Z', '昨日はありがとう')
    発言('少し前の発言', 'いまの配信', '111', '2026-09-29T11:40:00.000Z', 'さっきの話')
    発言('いまの発言', 'いまの配信', '111', '2026-09-29T11:59:00.000Z', 'ボス強そう')

    expect((await readUnreadChats(db, 条件)).map((chat) => chat.messageId)).toEqual(['いまの発言'])
  })

  it('上限を超えたら、新しいほうから上限まで読む（反応するのは直近の発言なので）', async () => {
    const { db, 発言 } = 配信中の発言を用意する()
    発言('1つ目', 'いまの配信', '111', '2026-09-29T11:55:00.000Z', 'こんばんは')
    発言('2つ目', 'いまの配信', '111', '2026-09-29T11:56:00.000Z', 'わこつ')
    発言('3つ目', 'いまの配信', '111', '2026-09-29T11:57:00.000Z', '草')

    expect((await readUnreadChats(db, { ...条件, limit: 2 })).map((chat) => chat.messageId)).toEqual(['2つ目', '3つ目'])
  })

  it('配信していなければ、何も読まない', async () => {
    const db = createFakeDatabase()

    expect(await readUnreadChats(db, 条件)).toEqual([])
  })
})

describe('markReadByJev', () => {
  it('まだ付け替えていない発言を、Jev が付けた既読として記録し、記録したことを返す', async () => {
    const db = createFakeDatabase()

    expect(await markReadByJev(db, 'たなかさんの初見の挨拶', 配信中の時刻)).toBe(true)
    expect(行を読む(db)).toEqual([{ message_id: 'たなかさんの初見の挨拶', read: 1, marked_by: 'jev', updated_at: '2026-09-29T12:00:00.000Z' }])
  })

  it('判定のあいだに配信者が手で付け替えていたら、上書きせずに記録しなかったことを返す', async () => {
    const db = createFakeDatabase()
    await recordCommentRead(db, { messageId: 'すずきさんのBGMの質問', read: false, by: 'manual' }, 配信中の時刻)

    expect(await markReadByJev(db, 'すずきさんのBGMの質問', 配信中の時刻 + 1000)).toBe(false)
    expect(行を読む(db)).toMatchObject([{ message_id: 'すずきさんのBGMの質問', read: 0, marked_by: 'manual' }])
  })
})

describe('unmarkReadByJev', () => {
  it('Jev が付けた既読を取り消す（画面へ知らせられなかったとき、次の判定でやり直せるようにする）', async () => {
    const db = createFakeDatabase()
    await markReadByJev(db, 'たなかさんの初見の挨拶', 配信中の時刻)

    await unmarkReadByJev(db, 'たなかさんの初見の挨拶')

    expect(行を読む(db)).toEqual([])
  })

  it('配信者が手で付けた状態は取り消さない', async () => {
    const db = createFakeDatabase()
    await recordCommentRead(db, { messageId: 'すずきさんのBGMの質問', read: true, by: 'manual' }, 配信中の時刻)

    await unmarkReadByJev(db, 'すずきさんのBGMの質問')

    expect(行を読む(db)).toMatchObject([{ message_id: 'すずきさんのBGMの質問', marked_by: 'manual' }])
  })
})
