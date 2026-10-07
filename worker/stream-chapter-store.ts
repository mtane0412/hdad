/**
 * 配信の章立ての読み書き
 *
 * 配信を約30分ごとの区間に分けて LLM がまとめた章（見出しと要約）を、migrations/0022_stream_chapters.sql の
 * stream_chapters に持つ。どこまでを章にしたかは stream_sessions.chaptered_until に持つ
 * （発話の無い区間は章を作らずに目印だけを進めるので、章の行からは分からないため）。
 *
 * 区間の材料（発話・発言・画面の文字）の読み出しもここに置く。3つのテーブルを同じ区間で切って読むのは章立てだけで、
 * あらすじ（目印より後ろを読む）やサイドスーパー（直近を読む）とは切り口が違うためである。
 *
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。
 */
import type { Database } from './database'
import type { ChapterLines, ChapterTarget, ChapterWindow } from './stream-chapter'

/** 保存する1章 */
export interface StreamChapterInput {
  sessionId: string
  /** 区間の始まり（ISO 8601。この時刻を含む） */
  startedAt: string
  /** 区間の終わり（ISO 8601。この時刻を含まない） */
  endedAt: string
  title: string
  summary: string
}

/** 読み出した1章 */
export interface StreamChapter {
  startedAt: string
  endedAt: string
  title: string
  summary: string
}

/**
 * 章を作る対象の配信を、始まった順に返す。
 *
 * 配信中の配信と、終わりまで章にし終えていない終わった配信が対象である。配信中でも区間がまだ閉じていなければ
 * 何もしないが、それは区間の決め方（stream-chapter.ts の nextChapterWindow）が見分ける。
 */
export const listChapterTargets = async (db: Database): Promise<ChapterTarget[]> => {
  const { results } = await db
    .prepare(
      `SELECT id, started_at AS startedAt, ended_at AS endedAt, chaptered_until AS chapteredUntil, title, category_name AS categoryName
       FROM stream_sessions
       WHERE ended_at IS NULL OR chaptered_until IS NULL OR chaptered_until < ended_at
       ORDER BY started_at, id`,
    )
    .all<ChapterTarget>()
  return results
}

/**
 * 区間の中の発話・発言・画面の文字を、それぞれ古い順に読む。
 *
 * 材料ごとに上限より1件多く読む。上限を超えたかどうかを呼び出し側（stream-chapter.ts の fitChapterMaterial）が
 * 見分け、超えていれば区間を縮めて残りを次の章に回すためである。
 *
 * 画面の文字は、撮った時刻ではなく篩を通して積んだ時刻（sifted_at）で区間に振り分ける。撮った時刻で振り分けると、
 * 区間が閉じたあとに遅れて積まれた1枚が、どの章の材料にもならないためである（stream_summaries の screen_until と同じ理由）。
 *
 * @param limits 材料ごとの件数の上限
 */
export const readChapterLines = async (
  db: Database,
  sessionId: string,
  window: ChapterWindow,
  limits: Readonly<Record<keyof ChapterLines, number>>,
): Promise<ChapterLines> => {
  const read = async (sql: string, limit: number) =>
    (await db.prepare(sql).bind(sessionId, window.from, window.to, limit + 1).all<{ text: string; at: string }>()).results
  return {
    transcripts: await read(
      `SELECT text, spoken_at AS at FROM transcripts
       WHERE session_id = ?1 AND spoken_at >= ?2 AND spoken_at < ?3
       ORDER BY spoken_at, message_id LIMIT ?4`,
      limits.transcripts,
    ),
    chats: await read(
      `SELECT text, sent_at AS at FROM stream_chat_messages
       WHERE session_id = ?1 AND sent_at >= ?2 AND sent_at < ?3
       ORDER BY sent_at, message_id LIMIT ?4`,
      limits.chats,
    ),
    screen: await read(
      `SELECT text, sifted_at AS at FROM screen_lines
       WHERE session_id = ?1 AND sifted_at >= ?2 AND sifted_at < ?3
       ORDER BY sifted_at, image_id, line_no LIMIT ?4`,
      limits.screen,
    ),
  }
}

/**
 * その時刻ちょうどの発話・発言・画面の文字を、それぞれ件数の上限なしで読む。
 *
 * 区間の始まりと同じ時刻の行が上限を超えて区間を切れないとき（stream-chapter.ts の fitChapterMaterial が null を返したとき）に、
 * その時刻の行を取りこぼさず1つの区間の材料にするために使う。同じ時刻に積まれるのは1回の収集で通した数枚ぶんの
 * 画面の文字くらいなので、上限なしでも読む量は限られる。
 */
export const readChapterLinesAt = async (db: Database, sessionId: string, at: string): Promise<ChapterLines> => {
  const read = async (sql: string) => (await db.prepare(sql).bind(sessionId, at).all<{ text: string; at: string }>()).results
  return {
    transcripts: await read(
      `SELECT text, spoken_at AS at FROM transcripts
       WHERE session_id = ?1 AND spoken_at = ?2
       ORDER BY message_id`,
    ),
    chats: await read(
      `SELECT text, sent_at AS at FROM stream_chat_messages
       WHERE session_id = ?1 AND sent_at = ?2
       ORDER BY message_id`,
    ),
    screen: await read(
      `SELECT text, sifted_at AS at FROM screen_lines
       WHERE session_id = ?1 AND sifted_at = ?2
       ORDER BY image_id, line_no`,
    ),
  }
}

/** 章を保存し、どこまでを章にしたかを章の終わりまで進める（片方だけが書かれないよう、ひとつのトランザクションで行う） */
export const saveStreamChapter = async (db: Database, chapter: StreamChapterInput): Promise<void> => {
  await db.batch([
    db
      .prepare(
        `INSERT INTO stream_chapters (session_id, started_at, ended_at, title, summary)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(chapter.sessionId, chapter.startedAt, chapter.endedAt, chapter.title, chapter.summary),
    db.prepare('UPDATE stream_sessions SET chaptered_until = ?2 WHERE id = ?1').bind(chapter.sessionId, chapter.endedAt),
  ])
}

/** 章を作らずに、どこまでを章にしたかだけを進める。発話の無い区間に使う */
export const skipChapterWindow = async (db: Database, sessionId: string, until: string): Promise<void> => {
  await db.prepare('UPDATE stream_sessions SET chaptered_until = ?2 WHERE id = ?1').bind(sessionId, until).run()
}

/** その配信の章を、区間の始まった順に返す */
export const listStreamChapters = async (db: Database, sessionId: string): Promise<StreamChapter[]> => {
  const { results } = await db
    .prepare(
      `SELECT started_at AS startedAt, ended_at AS endedAt, title, summary FROM stream_chapters
       WHERE session_id = ?1 ORDER BY started_at`,
    )
    .bind(sessionId)
    .all<StreamChapter>()
  return results
}
