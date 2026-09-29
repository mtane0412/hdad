/**
 * コメントの既読・未読の読み書き（comment-read-store.ts）のテスト
 *
 * コメントビューアーの発言1件ごとの既読・未読を、発言のIDで1行に持つ（comment_reads）。ここで確かめるのは次の点である。
 * - 既読にした・未読に戻したことを、誰が付けたか（手動か Jev か）と一緒に記録すること
 * - 同じ発言をもう一度付け替えると、行を増やさず上書きすること（最後に付けた状態だけが意味を持つため）
 * - 保持期間を過ぎた行を消せること（配信中の発言の本文と同じく、配信が終わったら要らない）
 */
import { describe, expect, it } from 'vitest'
import { deleteOldCommentReads, recordCommentRead } from './comment-read-store'
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
