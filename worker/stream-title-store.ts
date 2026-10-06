/**
 * 配信タイトルの候補の読み書き（試験運用。issue #268）
 *
 * 章ごとに作った配信タイトルの候補と、Jev の判定（公開してよいかの確率）を、
 * migrations/0028_stream_title_candidates.sql の stream_title_candidates に持つ。
 *
 * 候補を作る対象は、配信の最後の章で、まだ候補の無いものだけにする。作れなかった章は次の収集でやり直すが、
 * 次の章ができたら前の章には戻らない（タイトルは「いま」を表すもので、過ぎた章の候補には使い道が無いため）。
 *
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。
 */
import type { Database } from './database'
import type { StreamChapter } from './stream-chapter-store'

/**
 * 材料として読む画面の文字の行数の上限。
 *
 * 候補は短い一言で、画面の文字は何をしているかの手がかりにするだけなので、章（stream-chapter-store.ts）より少なくてよい。
 */
const SCREEN_LINE_LIMIT = 50

/** 候補を作る対象の章と、その区間に配信画面へ新しく現れた文字 */
export interface StreamTitleTarget {
  chapter: StreamChapter
  /** 古い順。篩を通して積んだ時刻（sifted_at）で区間に振り分ける（章と同じ） */
  screen: string[]
}

/** 保存する候補 */
export interface StreamTitleCandidateInput {
  sessionId: string
  /** 候補を作った章の始まり（stream_chapters.started_at） */
  chapterStartedAt: string
  candidate: string
  /** 配信タイトルとして公開してよいかを Jev に尋ねた、「よい」の確率（0〜1） */
  publishable: number
}

/** 読み出した候補 */
export interface StreamTitleCandidate {
  chapterStartedAt: string
  candidate: string
  publishable: number
}

/**
 * 次に候補を作る章を返す。その配信の最後の章に、まだ候補が無いときだけ返し、それ以外は null。
 */
export const readStreamTitleTarget = async (db: Database, sessionId: string): Promise<StreamTitleTarget | null> => {
  const chapter = await db
    .prepare(
      `SELECT c.started_at AS startedAt, c.ended_at AS endedAt, c.title, c.summary
       FROM stream_chapters c
       LEFT JOIN stream_title_candidates t ON t.session_id = c.session_id AND t.chapter_started_at = c.started_at
       WHERE c.session_id = ?1 AND c.started_at = (SELECT MAX(started_at) FROM stream_chapters WHERE session_id = ?1)
         AND t.session_id IS NULL`,
    )
    .bind(sessionId)
    .first<StreamChapter>()
  if (chapter === null) return null
  const { results } = await db
    .prepare(
      `SELECT text FROM screen_lines
       WHERE session_id = ?1 AND sifted_at >= ?2 AND sifted_at < ?3
       ORDER BY sifted_at, image_id, line_no LIMIT ?4`,
    )
    .bind(sessionId, chapter.startedAt, chapter.endedAt, SCREEN_LINE_LIMIT)
    .all<{ text: string }>()
  return { chapter, screen: results.map((line) => line.text) }
}

/**
 * 候補を保存する。
 *
 * @param now 作った時刻（ミリ秒）
 */
export const saveStreamTitleCandidate = async (db: Database, input: StreamTitleCandidateInput, now: number): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO stream_title_candidates (session_id, chapter_started_at, candidate, publishable, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(input.sessionId, input.chapterStartedAt, input.candidate, input.publishable, new Date(now).toISOString())
    .run()
}

/** その配信の候補を、章の始まった順に返す */
export const listStreamTitleCandidates = async (db: Database, sessionId: string): Promise<StreamTitleCandidate[]> => {
  const { results } = await db
    .prepare(
      `SELECT chapter_started_at AS chapterStartedAt, candidate, publishable FROM stream_title_candidates
       WHERE session_id = ?1 ORDER BY chapter_started_at`,
    )
    .bind(sessionId)
    .all<StreamTitleCandidate>()
  return results
}
