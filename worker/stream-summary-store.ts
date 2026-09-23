/**
 * 配信の「これまでのあらすじ」の読み書き
 *
 * cron（worker/collect.ts）が5分おきに作り直したあらすじを、配信の区切り（stream_sessions）ごとに1行だけ持つ
 * （migrations/0010_stream_summaries.sql の stream_summaries）。チャットのコマンドは、この貯めたものを
 * そのまま読んで返す（応答のたびにLLMを待つと応答が遅く、無料枠も読めないため）。
 *
 * あらすじは毎回ゼロから作り直すのではなく、前回のあらすじに新しい材料を積み上げて書き直させる
 * （viewers の summary と同じ考え方）。そのため「どこまでを材料にしたか」を材料ごとに持ち、
 * 次に作るときはその続きだけを読む。
 *
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。
 */
import type { Database } from './database'

const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/** 保存するあらすじ */
export interface StreamSummaryInput {
  /** どの配信のあらすじか */
  sessionId: string
  /** あらすじの本文 */
  summary: string
  /** 最後に材料にした発話（transcripts）の目印。材料が無ければ前回のまま */
  transcriptsUntil: Cursor
  /** 最後に材料にした発言（stream_chat_messages）の目印。材料が無ければ前回のまま */
  chatUntil: Cursor
}

/**
 * どこまで材料にしたかの目印。
 *
 * 日時だけでは足りない（同じ日時の行が件数の上限で分かれると取りこぼす）ので、読む順と同じ
 * 「日時・メッセージID」の組で持つ（worker/transcript-store.ts の TranscriptCursor を参照）。
 */
export interface Cursor {
  at: string
  messageId: string
}

/** 読み出したあらすじ */
export interface StreamSummary {
  summary: string
  transcriptsUntil: Cursor
  chatUntil: Cursor
  /** このあらすじを作った日時 */
  updatedAt: string
}

/** 保存してある行の形。目印は2列に分かれているので、読み出したあとで組に直す */
interface StreamSummaryRow {
  summary: string
  transcriptsUntil: string
  transcriptsUntilId: string
  chatUntil: string
  chatUntilId: string
  updatedAt: string
}

/** その配信のあらすじを読む。まだ作っていなければ null */
export const readStreamSummary = async (db: Database, sessionId: string): Promise<StreamSummary | null> => {
  const row = await db
    .prepare(
      `SELECT summary, transcripts_until AS transcriptsUntil, transcripts_until_id AS transcriptsUntilId,
              chat_until AS chatUntil, chat_until_id AS chatUntilId, updated_at AS updatedAt
       FROM stream_summaries WHERE session_id = ?1`,
    )
    .bind(sessionId)
    .first<StreamSummaryRow>()
  if (row === null) return null
  return {
    summary: row.summary,
    transcriptsUntil: { at: row.transcriptsUntil, messageId: row.transcriptsUntilId },
    chatUntil: { at: row.chatUntil, messageId: row.chatUntilId },
    updatedAt: row.updatedAt,
  }
}

/**
 * その配信のあらすじを書き換える。まだ無ければ作る。
 *
 * 1配信につき1行なので、作り直しは上書きになる。過去のあらすじは残らない（途中経過を溜める意味がないため）。
 */
export const saveStreamSummary = async (db: Database, input: StreamSummaryInput, now: number): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO stream_summaries (session_id, summary, transcripts_until, transcripts_until_id, chat_until, chat_until_id, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (session_id) DO UPDATE SET
         summary = excluded.summary,
         transcripts_until = excluded.transcripts_until,
         transcripts_until_id = excluded.transcripts_until_id,
         chat_until = excluded.chat_until,
         chat_until_id = excluded.chat_until_id,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.sessionId,
      input.summary,
      input.transcriptsUntil.at,
      input.transcriptsUntil.messageId,
      input.chatUntil.at,
      input.chatUntil.messageId,
      toIso(now),
    )
    .run()
}

/**
 * いま進んでいる配信のあらすじを読む。配信していない、またはまだ作っていなければ null。
 *
 * チャットのコマンド（応答文の差し込み語 {summary}）が呼ぶ。配信中の区切りを SELECT の中で引くので、
 * 前の配信のあらすじが次の配信に持ち越されることはない（配信が変わればあらすじもリセットされる）。
 *
 * 貯めたものをそのまま返すだけで、ここでLLMは呼ばない。応答のたびにLLMを待つと応答が遅く、
 * 無料枠（Neurons）も視聴者の発言数しだいになってしまうためである。
 */
export const readCurrentStreamSummary = async (db: Database, now: number): Promise<{ summary: string; updatedAt: string } | null> =>
  await db
    .prepare(
      `SELECT summary, updated_at AS updatedAt FROM stream_summaries
       WHERE session_id = (
         SELECT id FROM stream_sessions WHERE ended_at IS NULL AND started_at <= ?1 ORDER BY started_at DESC LIMIT 1
       )`,
    )
    .bind(toIso(now))
    .first<{ summary: string; updatedAt: string }>()
