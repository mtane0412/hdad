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
  /** 材料にした発話（transcripts）の spoken_at のうち最も新しいもの。材料が無ければ前回のまま */
  transcriptsUntil: string
  /** 材料にした発言（stream_chat_messages）の sent_at のうち最も新しいもの。材料が無ければ前回のまま */
  chatUntil: string
}

/** 読み出したあらすじ */
export interface StreamSummary {
  summary: string
  transcriptsUntil: string
  chatUntil: string
  /** このあらすじを作った日時 */
  updatedAt: string
}

/** その配信のあらすじを読む。まだ作っていなければ null */
export const readStreamSummary = async (db: Database, sessionId: string): Promise<StreamSummary | null> =>
  await db
    .prepare(
      `SELECT summary, transcripts_until AS transcriptsUntil, chat_until AS chatUntil, updated_at AS updatedAt
       FROM stream_summaries WHERE session_id = ?1`,
    )
    .bind(sessionId)
    .first<StreamSummary>()

/**
 * その配信のあらすじを書き換える。まだ無ければ作る。
 *
 * 1配信につき1行なので、作り直しは上書きになる。過去のあらすじは残らない（途中経過を溜める意味がないため）。
 */
export const saveStreamSummary = async (db: Database, input: StreamSummaryInput, now: number): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO stream_summaries (session_id, summary, transcripts_until, chat_until, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (session_id) DO UPDATE SET
         summary = excluded.summary,
         transcripts_until = excluded.transcripts_until,
         chat_until = excluded.chat_until,
         updated_at = excluded.updated_at`,
    )
    .bind(input.sessionId, input.summary, input.transcriptsUntil, input.chatUntil, toIso(now))
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
