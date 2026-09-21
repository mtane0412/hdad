/**
 * チャットボットの状態の読み書き
 *
 * 「この通知にはもう応答したか」と「このコマンドはクールダウン中か」をデータベース（D1）で持つ。
 * どちらもコマンドに一致した発言のときだけ書くので、書き込みの回数はコマンドが使われた回数に収まる。
 * テーブルの定義は migrations/0002_chat_bot.sql にある。日時は UTC の ISO 8601 の文字列で持つ。
 *
 * 注意: どちらの判定も SQLite の RETURNING を使い、1つの文の中で「書けたかどうか」を受け取る。
 * 「読んでから書く」に分けると、同時に届いた通知の間で判定が食い違う。
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。
 */
import type { Database } from './database'

/** 応答済みの鍵を残す期間（ミリ秒）。Twitchの再送は短時間に起きるので1時間で足りる */
const REPLY_RETENTION_MS = 60 * 60 * 1000
const MILLISECONDS_PER_SECOND = 1000

const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/**
 * この通知に応答してよいかを決め、応答するなら鍵を確保する。
 *
 * Twitchは応答が届かなかった通知を再送するため、これがないと同じ発言に二度応答してしまう。
 * あわせて、古い鍵（1時間より前）を消して増え続けないようにする。
 *
 * @returns 確保できれば true。既に応答済み（再送）なら false
 */
export const reserveChatReply = async (db: Database, messageId: string, now: number): Promise<boolean> => {
  await db.prepare('DELETE FROM replied_chat_messages WHERE replied_at < ?1').bind(toIso(now - REPLY_RETENTION_MS)).run()

  const reserved = await db
    .prepare(
      `INSERT INTO replied_chat_messages (message_id, replied_at) VALUES (?1, ?2)
       ON CONFLICT DO NOTHING
       RETURNING message_id`,
    )
    .bind(messageId, toIso(now))
    .first<{ message_id: string }>()
  return reserved !== null
}

/**
 * コマンドのクールダウンを消費する。
 *
 * 消費できなかったとき（クールダウン中）は、最後に使った時刻を更新しない。
 * 更新してしまうと、連打されている間はいつまでもクールダウンが明けない。
 *
 * @param cooldownSeconds 続けて応答しない秒数。0 なら毎回消費できる
 * @returns 消費できれば true。クールダウン中なら false
 */
export const consumeCooldown = async (db: Database, commandName: string, cooldownSeconds: number, now: number): Promise<boolean> => {
  const usableBefore = toIso(now - cooldownSeconds * MILLISECONDS_PER_SECOND)
  const consumed = await db
    .prepare(
      `INSERT INTO command_uses (command_name, used_at) VALUES (?1, ?2)
       ON CONFLICT (command_name) DO UPDATE SET used_at = ?2 WHERE used_at <= ?3
       RETURNING command_name`,
    )
    .bind(commandName, toIso(now), usableBefore)
    .first<{ command_name: string }>()
  return consumed !== null
}
