/**
 * コメントの既読・未読の読み書き
 *
 * コメントビューアー（/comments/）の発言1件ごとに、配信者が反応したか（既読）を持つ
 * （migrations/0020_comment_reads.sql の comment_reads）。行が無い発言は未読として扱う。
 * 画面への知らせは呼び出し側（comment-routes.ts）が配送先（comment-channel.ts）へ押し出して行い、
 * ここは記録だけを受け持つ。
 *
 * 配信者の発話からの判定（comment-reaction.ts）のために、いま進んでいる配信のまだ一度も付け替えていない
 * 視聴者の発言を読み（readUnreadChats）、反応したと判定されたものを Jev が付けた既読として記録する（markReadByJev）。
 *
 * 注意: 同じ発言を付け替えたときは行を増やさず上書きする。意味を持つのは最後に付けた状態だけである。
 * 注意: Jev が既読にするのは、まだ一度も付け替えていない発言だけである。配信者が手で既読にした・未読に戻した
 * 状態は上書きしない（手で未読に戻したものを Jev が既読にし直すと、配信者の判断を消してしまう）。
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

/** Jev に判定させる候補の発言 */
export interface UnreadChat {
  readonly messageId: string
  /** 発言した人の表示名（配信者が名前を呼んで返事をすることがあるので、判定の材料に含める） */
  readonly name: string
  readonly text: string
}

/** 候補の読み方 */
export interface UnreadChatQuery {
  /** 配信者のユーザーID。配信者自身の発言は、反応したかを見ないので読まない */
  readonly broadcasterId: string
  /** この時刻（ミリ秒）以降に届いた発言だけを読む。反応するのは直近の発言なので、古いものは候補にしない */
  readonly since: number
  /** 読む件数の上限。超えたぶんは古いほうから落とす */
  readonly limit: number
}

/**
 * いま進んでいる配信の、まだ一度も付け替えていない視聴者の発言を、届いた順（古い順）に読む。
 *
 * 配信中の発言の本文（stream_chat_messages）に、表示名（viewers）を合わせて読む。どちらも Webhook が同じ発言から
 * 書く（viewers が先）ので、表示名が欠けることはない。配信していなければ何も読まない。
 */
export const readUnreadChats = async (db: Database, { broadcasterId, since, limit }: UnreadChatQuery): Promise<UnreadChat[]> => {
  const { results } = await db
    .prepare(
      `SELECT m.message_id AS messageId, v.display_name AS name, m.text AS text
       FROM stream_chat_messages m
       JOIN viewers v ON v.user_id = m.user_id
       LEFT JOIN comment_reads r ON r.message_id = m.message_id
       WHERE m.session_id = (SELECT id FROM stream_sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1)
         AND r.message_id IS NULL
         AND m.user_id <> ?1
         AND m.sent_at >= ?2
       ORDER BY m.sent_at DESC, m.message_id DESC
       LIMIT ?3`,
    )
    .bind(broadcasterId, toIso(since), limit)
    .all<UnreadChat>()
  // 新しいほうから上限まで取り、判定に渡す向き（古い順）に直す
  return results.reverse()
}

/**
 * Jev が反応したと判定した発言を、既読として記録する。
 *
 * 判定のあいだに配信者が手で付け替えていたら上書きしない（ON CONFLICT DO NOTHING）。記録したかどうかを返すので、
 * 呼び出し側は記録したものだけを画面へ知らせる。
 *
 * @returns 記録したなら true、すでに付け替えられていて記録しなかったなら false
 */
export const markReadByJev = async (db: Database, messageId: string, now: number): Promise<boolean> => {
  const inserted = await db
    .prepare(
      `INSERT INTO comment_reads (message_id, read, marked_by, updated_at) VALUES (?1, 1, 'jev', ?2)
       ON CONFLICT (message_id) DO NOTHING
       RETURNING message_id`,
    )
    .bind(messageId, toIso(now))
    .first<{ message_id: string }>()
  return inserted !== null
}
