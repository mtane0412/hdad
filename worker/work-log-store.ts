/**
 * 作業ログの読み書き
 *
 * 開発の出来事を migrations/0023_dev_events.sql の dev_events に残し、合成ページの素材「作業ログ」が開き直したときに
 * いまの配信の出来事と章（stream_chapters）を混ぜて読み出す（issue #211）。
 *
 * 注意: 残すのは配信中に届いた出来事だけで、配信中の区切りは INSERT ... SELECT の中で引く
 * （「配信中かどうかを読んでから書く」に分けると、その間に配信が終わったときに食い違う。transcripts と同じ考え方）。
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。
 */
import type { Database } from './database'
import type { StreamChapter } from './stream-chapter-store'
import { chapterEntryOf, type DevEventInput, type WorkLogEntry } from './work-log'

const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/** いま配信中の配信。stream_sessions の配信中の区切り（ended_at が NULL）のうち、いちばん新しいもの */
const CURRENT_SESSION = 'SELECT id FROM stream_sessions WHERE ended_at IS NULL AND started_at <= ?1 ORDER BY started_at DESC LIMIT 1'

/**
 * 開発の出来事を、いまの配信の作業ログに1行残す。
 *
 * 同じ id（同じ X-GitHub-Delivery）で二度呼ばれても1行のままにし、最初に残した1行を返す。GitHub の Redeliver で
 * 押し出し直すときに、時刻が再送の時刻にずれて合成ページの並びが変わらないようにするためである。
 *
 * @returns 残っている1行。配信していなくて残さなかったなら null
 */
export const recordDevEvent = async (db: Database, event: DevEventInput, now: number): Promise<WorkLogEntry | null> => {
  const row = await db
    .prepare(
      // 配信中の行が無ければ SELECT が0行を返すので、INSERT も起きず RETURNING も何も返さない。
      // 再送では何も書き換えない更新で、最初の行を RETURNING に返させる。
      // WHERE true は、SELECT のあとの ON CONFLICT を結合の条件と読み違えさせないために SQLite が求めるもの
      `INSERT INTO dev_events (id, session_id, kind, text, occurred_at)
       SELECT ?2, id, ?3, ?4, ?1 FROM (${CURRENT_SESSION}) WHERE true
       ON CONFLICT (id) DO UPDATE SET id = dev_events.id
       RETURNING id, kind, occurred_at AS at, text`,
    )
    .bind(toIso(now), event.id, event.kind, event.text)
    .first<WorkLogEntry>()
  return row ?? null
}

/** 新しい順に並べる。時刻が同じなら id で決める（読み直すたびに並びが入れ替わらないため） */
const newestFirst = (left: WorkLogEntry, right: WorkLogEntry): number =>
  right.at.localeCompare(left.at) || right.id.localeCompare(left.id)

/**
 * いまの配信の作業ログを、新しい順に上限の件数まで読む。
 *
 * 開発の出来事と章をそれぞれ新しいほうから上限まで読み、混ぜて並べ直してから上限で切る
 * （どちらか一方だけで上限が埋まる場合も、混ぜた結果の新しいほうから上限までが必ず含まれる）。
 *
 * @returns 配信していなければ空の一覧（配信の前後にOBSを開いたままにするのが普通なので、失敗にしない）
 */
export const readWorkLog = async (db: Database, now: number, limit: number): Promise<WorkLogEntry[]> => {
  const session = await db.prepare(CURRENT_SESSION).bind(toIso(now)).first<{ id: string }>()
  if (session === null) return []

  const devEvents = await db
    .prepare(
      `SELECT id, kind, occurred_at AS at, text FROM dev_events
       WHERE session_id = ?1 ORDER BY occurred_at DESC, id DESC LIMIT ?2`,
    )
    .bind(session.id, limit)
    .all<WorkLogEntry>()
  const chapters = await db
    .prepare(
      `SELECT started_at AS startedAt, ended_at AS endedAt, title, summary FROM stream_chapters
       WHERE session_id = ?1 ORDER BY started_at DESC LIMIT ?2`,
    )
    .bind(session.id, limit)
    .all<StreamChapter>()

  return [...devEvents.results, ...chapters.results.map(chapterEntryOf)].sort(newestFirst).slice(0, limit)
}
