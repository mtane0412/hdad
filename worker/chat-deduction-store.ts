/**
 * チャットで推理のゲームの読み書き（D1 の chat_deduction_games。issue #375）
 *
 * 開催中のゲーム（ended_at が NULL）は1つだけで、開始のときに1つの文の中で確かめる（意見ボードのテーマと同じ形）。
 * 報酬をONにできなかったときに開始を無かったことにできるよう、開催中のゲームの行は消せる（cancelGame）。
 *
 * 注意: SQL はこのファイルだけが持ち、必ずプレースホルダを使う。
 */
import type { Database } from './database'

/** ゲームの終わり方（stopped: 配信者が打ち切った。solved: 正解者が出た） */
export type ChatDeductionEndReason = 'stopped' | 'solved'

/** ゲーム1つ */
export interface ChatDeductionGame {
  id: number
  /** src/chat-deduction/problems.json の問題のID */
  problemId: string
  startedAt: string
  /** 終えた時刻。開催中なら null */
  endedAt: string | null
  /** 終わり方。開催中なら null */
  endReason: ChatDeductionEndReason | null
}

const GAME_COLUMNS = 'id, problem_id AS problemId, started_at AS startedAt, ended_at AS endedAt, end_reason AS endReason'

const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/**
 * ゲームを始める。
 *
 * @returns 作ったゲーム。ほかのゲームが開催中なら作らず null
 */
export const startGame = async (db: Database, problemId: string, now: number): Promise<ChatDeductionGame | null> =>
  db
    .prepare(
      `INSERT INTO chat_deduction_games (problem_id, started_at)
       SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM chat_deduction_games WHERE ended_at IS NULL)
       RETURNING ${GAME_COLUMNS}`,
    )
    .bind(problemId, toIso(now))
    .first<ChatDeductionGame>()

/**
 * 開催中のゲームを終える。
 *
 * @returns 終えたゲーム。そのIDのゲームが無い・もう終えていれば null
 */
export const endGame = async (db: Database, id: number, reason: ChatDeductionEndReason, now: number): Promise<ChatDeductionGame | null> =>
  db
    .prepare(`UPDATE chat_deduction_games SET ended_at = ?2, end_reason = ?3 WHERE id = ?1 AND ended_at IS NULL RETURNING ${GAME_COLUMNS}`)
    .bind(id, toIso(now), reason)
    .first<ChatDeductionGame>()

/**
 * 開催中のゲームの行を消す。報酬をONにできず、ゲームを始められなかったときに使う（始まらなかったことにする）。
 *
 * 終えたゲームは消さない（記録として残す）。
 */
export const cancelGame = async (db: Database, id: number): Promise<void> => {
  await db.prepare('DELETE FROM chat_deduction_games WHERE id = ?1 AND ended_at IS NULL').bind(id).run()
}

/** 開催中のゲームを読む。開催中でなければ null */
export const readCurrentGame = async (db: Database): Promise<ChatDeductionGame | null> =>
  db.prepare(`SELECT ${GAME_COLUMNS} FROM chat_deduction_games WHERE ended_at IS NULL`).first<ChatDeductionGame>()

/** 最後に始めたゲームを読む（終えたものも含む）。一度も始めていなければ null */
export const readLatestGame = async (db: Database): Promise<ChatDeductionGame | null> =>
  db.prepare(`SELECT ${GAME_COLUMNS} FROM chat_deduction_games ORDER BY id DESC LIMIT 1`).first<ChatDeductionGame>()
