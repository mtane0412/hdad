/**
 * コメントの既読・未読の読み書き
 *
 * コメントビューアー（/comments/）の発言1件ごとに、配信者が反応したか（既読）を持つ
 * （migrations/0020_comment_reads.sql の comment_reads）。行が無い発言は未読として扱う。
 * 画面への知らせは呼び出し側（comment-routes.ts）が配送先（comment-channel.ts）へ押し出して行い、
 * ここは記録だけを受け持つ。
 *
 * 注意: 同じ発言を付け替えたときは行を増やさず上書きする。意味を持つのは最後に付けた状態だけである。
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。
 */
import type { Database } from './database'

/** 既読・未読を付け替えたのは誰か。manual は配信者が手で、jev は配信者の発話から判定して（issue #147） */
export type CommentReadMarker = 'manual' | 'jev'

/** 付け替えた1件 */
export interface CommentRead {
  /** 発言のID（Twitch が振ったもの。コメントビューアーの1件の messageId と同じ） */
  readonly messageId: string
  /** 既読にしたなら true、未読に戻したなら false */
  readonly read: boolean
  readonly by: CommentReadMarker
}

const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/** 既読にした・未読に戻したことを記録する。同じ発言の行があれば上書きする */
export const recordCommentRead = async (db: Database, record: CommentRead, now: number): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO comment_reads (message_id, read, marked_by, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (message_id) DO UPDATE SET read = excluded.read, marked_by = excluded.marked_by, updated_at = excluded.updated_at`,
    )
    .bind(record.messageId, record.read ? 1 : 0, record.by, toIso(now))
    .run()
}

/** 指定した時刻より前に付け替えた行を消す（配信が終わった発言の既読は要らないため。cron の collect.ts が呼ぶ） */
export const deleteOldCommentReads = async (db: Database, before: number): Promise<void> => {
  await db.prepare('DELETE FROM comment_reads WHERE updated_at < ?1').bind(toIso(before)).run()
}
