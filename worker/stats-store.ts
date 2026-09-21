/**
 * 配信の記録の読み書き
 *
 * 配信セッション・視聴者数・フォロワー数・収集の失敗をデータベース（D1）へ書き、管理用APIのために読み出す。
 * テーブルの定義は migrations/ にある。日時は UTC の ISO 8601 の文字列で持ち、文字列のまま大小を比べる。
 *
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。
 */
import type { Database } from './database'
import type { LiveStream } from './twitch'

/** 一覧で返す配信セッションの上限（新しい順） */
const SESSION_LIST_LIMIT = 100
/** 収集の失敗の記録を残す期間（ミリ秒）。ログインが切れたままだと5分おきに増え続けるので、古いものから消す */
const FAILURE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
/** 一覧で返す収集の失敗の上限（新しい順） */
const FAILURE_LIST_LIMIT = 50

export interface SessionSummary {
  id: string
  startedAt: string
  /** 配信中なら null */
  endedAt: string | null
  title: string
  categoryName: string
  /** 視聴者数の記録が無ければ null */
  averageViewers: number | null
  peakViewers: number | null
  /** 配信の開始から終了（配信中なら現在）までのフォロワー数の増減。フォロワー数の記録が無ければ null */
  followerDelta: number | null
  /** イベントの種類（EventSubの type）ごとの件数 */
  eventCounts: Record<string, number>
}

export interface ViewerSample {
  sampledAt: string
  viewerCount: number
}

export interface SessionDetail {
  id: string
  startedAt: string
  endedAt: string | null
  title: string
  categoryName: string
  samples: ViewerSample[]
}

export interface FollowerSample {
  sampledAt: string
  followerTotal: number
}

export interface CollectionFailure {
  occurredAt: string
  code: string
  message: string
}

const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/**
 * 配信中のときの記録。セッションを開始（続いていれば更新）し、視聴者数のサンプルを1つ足す。3つの文はまとめて実行する。
 *
 * @param now 現在時刻（ミリ秒）
 */
export const recordLiveStream = async (db: Database, stream: LiveStream, now: number): Promise<void> => {
  const sampledAt = toIso(now)
  await db.batch([
    // 閉じたはずの配信が続いていた場合（Twitchが一時的に「配信なし」と答えた場合）は開き直す
    db
      .prepare(
        `INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?1, ?2, NULL, ?3, ?4)
         ON CONFLICT (id) DO UPDATE SET ended_at = NULL, title = excluded.title, category_name = excluded.category_name`,
      )
      .bind(stream.id, stream.startedAt, stream.title, stream.categoryName),
    // 終了を見届けられなかった前の配信を閉じる
    db.prepare('UPDATE stream_sessions SET ended_at = ?1 WHERE ended_at IS NULL AND id <> ?2').bind(sampledAt, stream.id),
    // 同じ時刻の実行が重なっても二重に記録しない
    db
      .prepare('INSERT INTO viewer_samples (session_id, sampled_at, viewer_count) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING')
      .bind(stream.id, sampledAt, stream.viewerCount),
  ])
}

/** 配信していないときの記録。開いているセッションを現在時刻で閉じる */
export const closeOpenSessions = async (db: Database, now: number): Promise<void> => {
  await db.prepare('UPDATE stream_sessions SET ended_at = ?1 WHERE ended_at IS NULL').bind(toIso(now)).run()
}

/** フォロワー数を記録する。直前の記録と同じ値なら何も足さない（行数を抑えるため） */
export const recordFollowerTotal = async (db: Database, followerTotal: number, now: number): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO follower_samples (sampled_at, follower_total)
       SELECT ?1, ?2
       WHERE ?2 IS NOT (SELECT follower_total FROM follower_samples ORDER BY sampled_at DESC LIMIT 1)
       ON CONFLICT DO NOTHING`,
    )
    .bind(toIso(now), followerTotal)
    .run()
}

/** 収集の失敗を記録し、保持期間を過ぎた記録を消す */
export const recordFailure = async (db: Database, code: string, message: string, now: number): Promise<void> => {
  await db.batch([
    db
      .prepare(
        `INSERT INTO collection_failures (occurred_at, code, message) VALUES (?1, ?2, ?3)
         ON CONFLICT (occurred_at) DO UPDATE SET code = excluded.code, message = excluded.message`,
      )
      .bind(toIso(now), code, message),
    db.prepare('DELETE FROM collection_failures WHERE occurred_at < ?1').bind(toIso(now - FAILURE_RETENTION_MS)),
  ])
}

interface SessionRow {
  id: string
  startedAt: string
  endedAt: string | null
  title: string
  categoryName: string
}

interface SessionSummaryRow extends SessionRow {
  averageViewers: number | null
  peakViewers: number | null
  followerDelta: number | null
}

const SESSION_COLUMNS = 's.id AS id, s.started_at AS startedAt, s.ended_at AS endedAt, s.title AS title, s.category_name AS categoryName'

/**
 * 配信セッションの一覧（新しい順）。
 *
 * フォロワー増減は「終了時点（配信中なら現在）の値 − 開始時点の値」。ある時点の値は、その時点以前で最新の記録から取る。
 * 開始以前の記録が無い（記録を始めて最初の配信）ときは、いちばん古い記録を開始時点の値として扱う。
 *
 * @param now 現在時刻（ミリ秒）
 */
export const listSessions = async (db: Database, now: number): Promise<SessionSummary[]> => {
  const { results: sessions } = await db
    .prepare(
      `SELECT ${SESSION_COLUMNS},
         (SELECT ROUND(AVG(viewer_count), 1) FROM viewer_samples WHERE session_id = s.id) AS averageViewers,
         (SELECT MAX(viewer_count) FROM viewer_samples WHERE session_id = s.id) AS peakViewers,
         (SELECT follower_total FROM follower_samples WHERE sampled_at <= COALESCE(s.ended_at, ?1) ORDER BY sampled_at DESC LIMIT 1)
           - COALESCE(
               (SELECT follower_total FROM follower_samples WHERE sampled_at <= s.started_at ORDER BY sampled_at DESC LIMIT 1),
               (SELECT follower_total FROM follower_samples ORDER BY sampled_at ASC LIMIT 1)
             ) AS followerDelta
       FROM stream_sessions AS s
       ORDER BY s.started_at DESC
       LIMIT ?2`,
    )
    .bind(toIso(now), SESSION_LIST_LIMIT)
    .all<SessionSummaryRow>()

  const { results: counts } = await db
    .prepare(
      `SELECT session_id AS sessionId, type, COUNT(*) AS count FROM stream_events
       WHERE session_id IN (SELECT id FROM stream_sessions ORDER BY started_at DESC LIMIT ?1)
       GROUP BY session_id, type`,
    )
    .bind(SESSION_LIST_LIMIT)
    .all<{ sessionId: string; type: string; count: number }>()

  return sessions.map((session) => ({
    ...session,
    eventCounts: Object.fromEntries(counts.filter((row) => row.sessionId === session.id).map((row) => [row.type, row.count])),
  }))
}

/** 配信セッションと、その視聴者数の時系列（古い順）。存在しなければ null */
export const getSession = async (db: Database, id: string): Promise<SessionDetail | null> => {
  const session = await db.prepare(`SELECT ${SESSION_COLUMNS} FROM stream_sessions AS s WHERE s.id = ?1`).bind(id).first<SessionRow>()
  if (!session) return null

  const { results: samples } = await db
    .prepare('SELECT sampled_at AS sampledAt, viewer_count AS viewerCount FROM viewer_samples WHERE session_id = ?1 ORDER BY sampled_at ASC')
    .bind(id)
    .all<ViewerSample>()
  return { ...session, samples }
}

/** フォロワー数の時系列（古い順）。値が変わった時点だけが並ぶ */
export const listFollowerSamples = async (db: Database): Promise<FollowerSample[]> => {
  const { results } = await db
    .prepare('SELECT sampled_at AS sampledAt, follower_total AS followerTotal FROM follower_samples ORDER BY sampled_at ASC')
    .all<FollowerSample>()
  return results
}

/** 収集の失敗の一覧（新しい順） */
export const listFailures = async (db: Database): Promise<CollectionFailure[]> => {
  const { results } = await db
    .prepare('SELECT occurred_at AS occurredAt, code, message FROM collection_failures ORDER BY occurred_at DESC LIMIT ?1')
    .bind(FAILURE_LIST_LIMIT)
    .all<CollectionFailure>()
  return results
}
