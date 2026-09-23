/**
 * 人物像の材料になる、配信中のチャットの一時的な記録の読み書き
 *
 * 人物像（viewers の summary）は、その人が何を話したかが無いと作れない。集計値（発言数・バッジ・初回と
 * 最後の発言日時）だけでは、LLMに推測させても中身のない文にしかならないためである。そこで配信中のあいだだけ
 * 発言の本文を貯め（migrations/0008_viewer_summaries.sql の stream_chat_messages）、配信が終わったあとに
 * 人ごとにまとめて人物像を作り、使い終えた材料はすぐ消す（worker/collect.ts）。
 *
 * チャットの全文は貯めないという方針（.claude/CLAUDE.md）の、意識して設けた例外である。
 * 永く持つのは人の記録（viewers。1人1行）だけで、ここに貯まるのは配信中のぶんに限られる。
 *
 * 注意: 記録するのは配信中の区切り（stream_sessions の ended_at IS NULL の行）があるときだけで、
 * 無ければ1行も書かない（stream_events と同じ結びつけ方）。テスト配信の前後や配信外の発言を貯めないためである。
 * 注意: 材料として読み出すのは終わった配信のぶんだけである。配信中に人物像を作ると、その後の発言が入らない。
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。
 */
import type { Database } from './database'

const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/** 貯める発言。通知から取り出した値（chat-command.ts の ChatMessage）を組み替えて渡す */
export interface StreamChatMessage {
  /** Twitchが振ったメッセージのID。再送で同じ発言を二重に貯めないための鍵 */
  messageId: string
  /** 発言した人のユーザーID。人物像は人ごとに作るので、まとめる鍵になる */
  userId: string
  /** 発言の本文 */
  text: string
}

/** 人物像を作る対象。その人が、終わった配信で何回発言したか */
export interface SummaryTarget {
  userId: string
  messageCount: number
}

/**
 * 配信中に届いた発言を貯める。配信していなければ1行も書かない。
 *
 * bot自身の発言では呼ばない（呼び出し側が確かめる）。
 *
 * 注意: 配信中の区切りは INSERT ... SELECT の中で引く。「配信中かどうかを読んでから書く」に分けると
 * 読み出しが1回増えるうえ、その間に配信が終わると食い違う（stream_events と同じ考え方）。
 * 注意: 発言のたびに1行書くので、D1の書き込みの枠を使う。viewers（10分の間引き）とは意識して違えている。
 * 人物像には発言そのものが要るためで、貯まるのは配信中のぶんだけである。
 */
export const recordStreamChatMessage = async (db: Database, message: StreamChatMessage, now: number): Promise<void> => {
  const at = toIso(now)
  await db
    .prepare(
      `INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text)
       SELECT ?1, id, ?2, ?3, ?4 FROM stream_sessions
       WHERE ended_at IS NULL AND started_at <= ?3
       ORDER BY started_at DESC LIMIT 1
       ON CONFLICT DO NOTHING`,
    )
    .bind(message.messageId, message.userId, at, message.text)
    .run()
}

/**
 * 人物像をまだ作っていない人を、終わった配信での発言が多い順に返す。
 *
 * 人物像を作り終えた人の材料は消すので（deleteStreamChatMessages）、材料が残っていること自体が
 * 「まだ作っていない」という印になる。作った日時などの列を別に持たなくて済む。
 *
 * @param limit 一度に返す人数。1回の cron で呼ぶLLMの回数（Workers AI の無料枠と、Workers の
 *   サブリクエストの上限）を抑えるための歯止めである
 */
export const listSummaryTargets = async (db: Database, limit: number): Promise<SummaryTarget[]> => {
  const { results } = await db
    .prepare(
      `SELECT user_id AS userId, COUNT(*) AS messageCount FROM stream_chat_messages
       WHERE session_id IN (SELECT id FROM stream_sessions WHERE ended_at IS NOT NULL)
       GROUP BY user_id
       ORDER BY messageCount DESC, user_id
       LIMIT ?1`,
    )
    .bind(limit)
    .all<SummaryTarget>()
  return results
}

/**
 * その人の発言の本文を、終わった配信のぶんだけ古い順に読む。
 *
 * @param limit 読む件数の上限。話し続ける人ほど行が多いので、LLMへ渡す材料の量を一定に抑える
 *   （D1の rows read も食わない）。超えた分は古いほうから採り、新しいほうを切る
 */
export const readViewerMessages = async (db: Database, userId: string, limit: number): Promise<string[]> => {
  const { results } = await db
    .prepare(
      `SELECT text FROM stream_chat_messages
       WHERE user_id = ?1 AND session_id IN (SELECT id FROM stream_sessions WHERE ended_at IS NOT NULL)
       ORDER BY sent_at, message_id
       LIMIT ?2`,
    )
    .bind(userId, limit)
    .all<{ text: string }>()
  return results.map((row) => row.text)
}

/**
 * その配信の発言のうち、まだあらすじの材料にしていないぶんを、届いた順に読む。
 *
 * 人物像づくり（readViewerMessages）が終わった配信を人ごとに読むのに対し、あらすじ（issue #65）は
 * いま進んでいる配信を時系列で読む。同じテーブルを、別の目的で別の切り口から読むことになる。
 *
 * 誰の発言かは読まない。あらすじに要るのは「どんな反応があったか」であって、視聴者の名前ではないためである
 * （名前まで渡すと、LLMに個人の話として書かれてしまう）。
 *
 * @param since この日時より後に届いたぶんだけを読む。まだ一度もあらすじを作っていなければ空文字を渡す
 * @param limit 読む件数の上限。上限を超えたぶんは新しいほうを切り、次にあらすじを作るときへ回す
 */
export const readSessionChatSince = async (
  db: Database,
  sessionId: string,
  since: string,
  limit: number,
): Promise<{ text: string; at: string }[]> => {
  const { results } = await db
    .prepare(
      `SELECT text, sent_at AS at FROM stream_chat_messages
       WHERE session_id = ?1 AND sent_at > ?2
       ORDER BY sent_at, message_id
       LIMIT ?3`,
    )
    .bind(sessionId, since, limit)
    .all<{ text: string; at: string }>()
  return results
}

/**
 * 人物像を作り終えた人の材料を消す。
 *
 * 消すのは終わった配信のぶんだけである。配信中のぶんまで消すと、いま進んでいる配信の材料が失われる。
 */
export const deleteStreamChatMessages = async (db: Database, userId: string): Promise<void> => {
  await db
    .prepare(
      `DELETE FROM stream_chat_messages
       WHERE user_id = ?1 AND session_id IN (SELECT id FROM stream_sessions WHERE ended_at IS NOT NULL)`,
    )
    .bind(userId)
    .run()
}

/**
 * その人の材料を、配信中のぶんまで含めてすべて消す。
 *
 * 視聴者の記録を消すとき（本人から求められたときに応じる削除）に呼ぶ。人物像づくりのあとの掃除
 * （deleteStreamChatMessages）と違って配信中のぶんも消すのは、いま進んでいる配信の発言を残すと、
 * 記録を消したあとも本文が手元に残り続けてしまうためである。
 */
export const deleteAllStreamChatMessages = async (db: Database, userId: string): Promise<void> => {
  await db.prepare('DELETE FROM stream_chat_messages WHERE user_id = ?1').bind(userId).run()
}

/**
 * 古くなった材料を消す。
 *
 * 人物像を作れないまま残った材料（LLMの無料枠を使い切った日など）が積み上がらないようにするためのもので、
 * cron の収集のついでに呼ぶ（first_chatters の掃除と同じ扱い）。
 */
export const deleteOldStreamChatMessages = async (db: Database, before: number): Promise<void> => {
  await db.prepare('DELETE FROM stream_chat_messages WHERE sent_at < ?1').bind(toIso(before)).run()
}
