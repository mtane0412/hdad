/**
 * サイドスーパーの読み書き
 *
 * cron（worker/collect.ts）が5分おきに作り直した文言を、配信の区切り（stream_sessions）ごとに1行だけ持つ
 * （migrations/0011_side_supers.sql の side_supers）。オーバーレイ（side-super/index.html）は、
 * 貯めたものを GET /api/overlay/side-super で読み出して映すだけで、LLMは呼ばない。
 *
 * あらすじ（stream-summary-store.ts）と違って前回のものに積み上げないので、「どこまでを材料にしたか」の
 * 目印は持たない。毎回その時点の直近の材料から作り直す（worker/side-super.ts）。
 *
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。
 */
import type { Database } from './database'
import type { SideSuperLines } from './side-super'

const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/** 読み出したサイドスーパー */
export interface SideSuper {
  /** 表示する行（見出しと本文の2行） */
  lines: SideSuperLines
  /** この文言を作った日時 */
  updatedAt: string
}

/**
 * その配信のサイドスーパーを書き換える。まだ無ければ作る。
 *
 * 1配信につき1行なので、作り直しは上書きになる（過去の文言は残らない）。
 */
export const saveSideSuper = async (db: Database, sessionId: string, lines: SideSuperLines, now: number): Promise<void> => {
  const [line1, line2] = lines
  await db
    .prepare(
      `INSERT INTO side_supers (session_id, line1, line2, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (session_id) DO UPDATE SET
         line1 = excluded.line1,
         line2 = excluded.line2,
         updated_at = excluded.updated_at`,
    )
    .bind(sessionId, line1, line2, toIso(now))
    .run()
}

/**
 * 読み出した行を、保存の形（2列）から組に直す。
 *
 * サイドスーパーは必ず見出しと本文の2行なので（worker/side-super.ts の SIDE_SUPER_LINES）、
 * 場合分けは要らない。2行に固定する前に保存された1行だけの行は
 * migrations/0013_side_super_two_lines.sql が消してあるので、ここに空の本文は来ない。
 */
const toSideSuper = (row: { line1: string; line2: string; updatedAt: string }): SideSuper => ({
  lines: [row.line1, row.line2],
  updatedAt: row.updatedAt,
})

/**
 * その配信のサイドスーパーを読む。まだ作っていなければ null。
 *
 * cron（worker/collect.ts）が「前回いつ作ったか」を知るために呼ぶ。前回より新しい材料が1件も
 * 無ければLLMを呼ばずに済ませる（無料枠の節約）。配信中かどうかは呼び出し側が知っているので、
 * ここでは引かない。
 */
export const readSideSuper = async (db: Database, sessionId: string): Promise<SideSuper | null> => {
  const row = await db
    .prepare('SELECT line1, line2, updated_at AS updatedAt FROM side_supers WHERE session_id = ?1')
    .bind(sessionId)
    .first<{ line1: string; line2: string; updatedAt: string }>()
  return row === null ? null : toSideSuper(row)
}

/**
 * いま進んでいる配信のサイドスーパーを読む。配信していない、またはまだ作っていなければ null。
 *
 * オーバーレイからの読み出し（worker/overlay-routes.ts）が呼ぶ。配信中の区切りを SELECT の中で引くので、
 * 前の配信の文言が次の配信に持ち越されることはない（readCurrentStreamSummary と同じ作り）。
 */
export const readCurrentSideSuper = async (db: Database, now: number): Promise<SideSuper | null> => {
  const row = await db
    .prepare(
      `SELECT line1, line2, updated_at AS updatedAt FROM side_supers
       WHERE session_id = (
         SELECT id FROM stream_sessions WHERE ended_at IS NULL AND started_at <= ?1 ORDER BY started_at DESC LIMIT 1
       )`,
    )
    .bind(toIso(now))
    .first<{ line1: string; line2: string; updatedAt: string }>()
  return row === null ? null : toSideSuper(row)
}
