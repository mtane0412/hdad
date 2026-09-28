/**
 * 配信画面の取り込みの記録の読み書き
 *
 * OBSのブラウザソースに置いた裏方のページ（overlay/backstage/）が撮った1枚を、Worker が Gyazo へ上げて
 * （POST /api/overlay/screen）、その画像IDをここに残す。画像そのものは持たず、あとからOCRのテキストを
 * 取りに行くための手がかりだけを持つ（issue #122）。
 *
 * 上げた1枚のOCRは上げた直後には生成が終わっていないので、ここでは「まだ取れていない行を引く」
 * （listPendingOcr）と「取れた文字を書き戻す」（saveScreenOcr）を分けて持ち、取りに行くのは cron である。
 *
 * 貯めるのは配信中のぶんだけで、配信者の発話（transcript-store.ts）と同じく永く持つものではない。
 *
 * 注意: 記録するのは配信中の区切り（stream_sessions の ended_at IS NULL の行）があるときだけで、
 * 無ければ1行も書かない（transcripts・stream_events と同じ結びつけ方）。配信前の準備画面や配信後の
 * デスクトップを貯めないためである。
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。
 */
import type { Database } from './database'

const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/**
 * 配信中に撮った1枚を記録する。配信していなければ1行も書かない。
 *
 * 注意: 配信中の区切りは INSERT ... SELECT の中で引く。「配信中かどうかを読んでから書く」に分けると
 * 読み出しが1回増えるうえ、その間に配信が終わると食い違う（transcripts と同じ考え方）。
 * 注意: 同じ画像IDで二度呼ばれても、どちらにも true を返す。Gyazo は同じ画面の画像を同じ画像IDへ畳むので、
 * 画面が変わらないあいだは同じ画像IDが返り続ける。そのとき captured_at は最初のまま残す
 * （撮った時刻を更新すると、その画面を最初に見た時刻が分からなくなる）。
 *
 * @param imageId Gyazo が振った画像ID
 * @param capturedAt 撮った時刻（ミリ秒）
 * @returns 記録したなら true。配信していなくて捨てたなら false
 */
export const recordScreenCapture = async (db: Database, imageId: string, capturedAt: number): Promise<boolean> => {
  const recorded = await db
    .prepare(
      // 配信中の行が無ければ SELECT が0行を返すので、INSERT も起きず RETURNING も何も返さない
      `INSERT INTO screen_captures (image_id, session_id, captured_at)
       SELECT ?1, id, ?2 FROM stream_sessions
       WHERE ended_at IS NULL AND started_at <= ?2
       ORDER BY started_at DESC LIMIT 1
       ON CONFLICT (image_id) DO UPDATE SET captured_at = screen_captures.captured_at
       RETURNING image_id`,
    )
    .bind(imageId, toIso(capturedAt))
    .first<{ image_id: string }>()
  return recorded !== null
}

/**
 * いま配信中かどうか。
 *
 * 撮った1枚を Gyazo へ上げる前に確かめる（worker/overlay-routes.ts の postScreen）。記録するときにも
 * 配信中の区切りを引くので判定は二重になるが、配信前の準備画面や配信後のデスクトップを外（Gyazo）へ
 * 出してしまわないために、上げる前にも見る。
 *
 * @param now 現在時刻（ミリ秒）
 */
export const isStreaming = async (db: Database, now: number): Promise<boolean> => {
  const session = await db
    .prepare('SELECT id FROM stream_sessions WHERE ended_at IS NULL AND started_at <= ?1 ORDER BY started_at DESC LIMIT 1')
    .bind(toIso(now))
    .first<{ id: string }>()
  return session !== null
}

/**
 * 1枚のOCRを取りに行って空で返ったときに、諦めるまでの回数。
 *
 * Gyazo のOCRは上げた直後には生成が終わっておらず（実測で約10〜13秒）、取りに行っても空で返る。
 * cron は5分おきなので、次の収集までにはほぼ必ず生成が終わっている。それでも空が続く画像は何らかの理由で
 * 生成されないものとみなし、この回数で諦める（外への呼び出しを無限に繰り返さないため）。
 */
export const OCR_MAX_ATTEMPTS = 3

/** OCRをまだ取れていない1枚 */
export interface PendingOcr {
  /** Gyazo が振った画像ID */
  readonly imageId: string
  /** 撮った時刻（UTCのISO 8601） */
  readonly capturedAt: string
}

/**
 * OCRをまだ取れていない行を、撮った順に引く。
 *
 * 撮った順に引くのは、画面に現れた文字を古い順に材料へ積むためである（issue #122 Phase 4）。
 *
 * 注意: 試みた回数が OCR_MAX_ATTEMPTS に達した行は引かない。取れないままの行はここから外れ、
 * 保持期間（worker/collect.ts の SCREEN_CAPTURE_RETENTION_MS）で消える。
 *
 * @param limit 一度に引く件数の上限
 */
export const listPendingOcr = async (db: Database, limit: number): Promise<PendingOcr[]> => {
  const { results } = await db
    .prepare(
      `SELECT image_id, captured_at FROM screen_captures
       WHERE ocr_text IS NULL AND ocr_attempts < ?1
       ORDER BY captured_at, image_id LIMIT ?2`,
    )
    .bind(OCR_MAX_ATTEMPTS, limit)
    .all<{ image_id: string; captured_at: string }>()
  return results.map((row) => ({ imageId: row.image_id, capturedAt: row.captured_at }))
}

/**
 * 読み取った文字を記録する。
 *
 * 注意: 空文字も記録する。文字が1つも写っていない画面はありうるので、空を「取れなかった」として
 * 取りに行き直すと、その画像を上限まで叩き続けることになる。
 *
 * @param imageId Gyazo が振った画像ID
 * @param text 読み取った文字（1文字も無ければ空文字）
 */
export const saveScreenOcr = async (db: Database, imageId: string, text: string): Promise<void> => {
  await db.prepare('UPDATE screen_captures SET ocr_text = ?2 WHERE image_id = ?1').bind(imageId, text).run()
}

/**
 * 取りに行ったが、まだ生成されていなかったことを1回として数える。
 *
 * OCR_MAX_ATTEMPTS に達すると listPendingOcr が引かなくなる。
 *
 * @param imageId Gyazo が振った画像ID
 */
export const countOcrAttempt = async (db: Database, imageId: string): Promise<void> => {
  await db.prepare('UPDATE screen_captures SET ocr_attempts = ocr_attempts + 1 WHERE image_id = ?1').bind(imageId).run()
}

/**
 * 期限より古い取り込みの記録を消す。
 *
 * 画面の取り込みは配信中だけ持つものなので、終わった配信のぶんを残しておく意味はない。cron の収集のついでに
 * 呼ぶ（文字起こしの掃除と同じ扱い）。
 *
 * 注意: 配信中の区切りのぶんは、期限より古くても消さない。期限より長く続く配信（耐久配信など）の途中で
 * 序盤の記録を消してしまうと、あらすじが配信の始まりの画面を語れなくなる。
 *
 * @param before この時刻より前に撮った行を消す
 */
export const deleteOldScreenCaptures = async (db: Database, before: number): Promise<void> => {
  await db
    .prepare('DELETE FROM screen_captures WHERE captured_at < ?1 AND session_id NOT IN (SELECT id FROM stream_sessions WHERE ended_at IS NULL)')
    .bind(toIso(before))
    .run()
}
