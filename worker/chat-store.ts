/**
 * チャットボットの状態の読み書き
 *
 * 「この通知にはもう応答したか」「このコマンドはクールダウン中か」「同じ文面が何件続いたか」をデータベース（D1）で持つ。
 * 最初の2つはコマンドに一致した発言のとき、最後の1つは連投のルールが有効なときだけ書くので、チャットの全件は書かない。
 * テーブルの定義は migrations/0002_chat_bot.sql・0003_chat_moderation.sql にある。日時は UTC の ISO 8601 の文字列で持つ。
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

/** 連投を数えるために記録する発言 */
export interface RecentMessage {
  /** Twitchが振ったメッセージのID。再送で同じ発言を二重に数えないための鍵 */
  messageId: string
  chatterUserId: string
  /** 本文。前後の空白と大文字小文字の違いは同じ文面として扱う */
  text: string
  /** 何秒さかのぼって数えるか（連投のルールの窓） */
  windowSeconds: number
}

/**
 * 本文を、連投の判定に使うハッシュ（SHA-256の16進）にする。
 *
 * 本文そのものをデータベースに置かないのは、数えるのに中身が要らないうえ、チャットの中身を貯め込まないため。
 * 前後の空白と大文字小文字をそろえてから計算するので、「うおお」と「 うおお 」は同じ文面として数える。
 */
const hashText = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.trim().toLowerCase()))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * この発言を記録し、同じ発言者が窓のあいだに送った同じ文面の件数を返す（この発言を含む）。
 *
 * 判定より先に自分の1件を書き込むのは、「読んでから書く」に分けると、同時に届いた通知の間で件数が食い違うため。
 * あわせて、窓より古い行を消して増え続けないようにする。
 *
 * 注意: 同じメッセージIDの行は増やさない（メッセージIDが主キー）。Twitchの再送で行が増えると、
 * 1回しか発言していない人を連投とみなして誤って処分してしまう。
 *
 * 注意: 呼び出し側は、連投のルールが有効なときだけこれを呼ぶ（チャットは件数の桁が違い、
 * 1通ごとに書くと配信の記録とD1の書き込みの枠を食い合う）。
 *
 * @returns 窓の中にある同じ文面の件数（必ず1以上。自分の1件を含む）
 */
export const recordAndCountRecentMessage = async (db: Database, message: RecentMessage, now: number): Promise<number> => {
  const since = toIso(now - message.windowSeconds * MILLISECONDS_PER_SECOND)
  const textHash = await hashText(message.text)

  await db.prepare('DELETE FROM chat_recent_messages WHERE sent_at < ?1').bind(since).run()
  await db
    .prepare(
      `INSERT INTO chat_recent_messages (message_id, chatter_user_id, text_hash, sent_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT DO NOTHING`,
    )
    .bind(message.messageId, message.chatterUserId, textHash, toIso(now))
    .run()

  const counted = await db
    .prepare('SELECT COUNT(*) AS count FROM chat_recent_messages WHERE chatter_user_id = ?1 AND text_hash = ?2 AND sent_at >= ?3')
    .bind(message.chatterUserId, textHash, since)
    .first<{ count: number }>()
  // 直前に自分の1件を書いているので、数えられないことはない。それでも欠けたなら「連投ではない」側へ倒す
  return counted?.count ?? 1
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
