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
 * その1枚を、もう取りに行かない扱いにする。
 *
 * 画像が Gyazo から消えている（404）ときに使う。放っておくと、撮った順に引く listPendingOcr の先頭に
 * 居座り続け、そこで止まるたびに後ろの1枚も取りに行けなくなる（worker/collect.ts の fetchScreenOcr）。
 *
 * 注意: 読み取った文字は入れない。読み取れなかったことと、文字が1つも写っていなかったことは別である。
 *
 * @param imageId Gyazo が振った画像ID
 */
export const abandonOcr = async (db: Database, imageId: string): Promise<void> => {
  await db.prepare('UPDATE screen_captures SET ocr_attempts = ?2 WHERE image_id = ?1').bind(imageId, OCR_MAX_ATTEMPTS).run()
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

/** 読み取った文字はあるが、まだ篩に通していない1枚 */
export interface PendingSift {
  /** Gyazo が振った画像ID */
  readonly imageId: string
  /** その1枚を撮った配信の区切り */
  readonly sessionId: string
  /** 撮った時刻（UTCのISO 8601） */
  readonly capturedAt: string
  /** Gyazo が読み取った文字 */
  readonly ocrText: string
}

/**
 * 読み取った文字があって、まだ篩（worker/screen-ocr.ts）に通していない行を、撮った順に引く。
 *
 * 撮った順に引くのは、既出の判定が「それまでに渡した行」と照らすものであり、順番を入れ替えると
 * どちらが初出か変わってしまうためである。
 *
 * @param limit 一度に引く件数の上限
 */
export const listPendingSift = async (db: Database, limit: number): Promise<PendingSift[]> => {
  const { results } = await db
    .prepare(
      `SELECT image_id, session_id, captured_at, ocr_text FROM screen_captures
       WHERE ocr_text IS NOT NULL AND sifted_at IS NULL
       ORDER BY captured_at, image_id LIMIT ?1`,
    )
    .bind(limit)
    .all<{ image_id: string; session_id: string; captured_at: string; ocr_text: string }>()
  return results.map((row) => ({
    imageId: row.image_id,
    sessionId: row.session_id,
    capturedAt: row.captured_at,
    ocrText: row.ocr_text,
  }))
}

/**
 * 篩を通った行を積み、その1枚を通し終えたことにする。
 *
 * 注意: 残った行が0行でも通し終えたことにする。同じ画面を撮り続けるあいだ0行になるのが普通なので、
 * screen_lines に行があるかどうかで代用すると、そうした1枚を毎回引き直すことになる。
 * 注意: 同じ1枚を二度通しても行は増えない（image_id と line_no の組が主キー）。
 *
 * @param capture 篩に通した1枚
 * @param lines 篩を通った行（画面に現れた順）
 * @param now 通し終えた時刻（ミリ秒）
 */
export const saveScreenLines = async (
  db: Database,
  capture: { imageId: string; sessionId: string; capturedAt: string },
  lines: readonly string[],
  now: number,
): Promise<void> => {
  const 書き込み = lines.map((text, lineNo) =>
    db
      .prepare(
        `INSERT INTO screen_lines (image_id, line_no, session_id, captured_at, text)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT DO NOTHING`,
      )
      .bind(capture.imageId, lineNo, capture.sessionId, capture.capturedAt, text),
  )
  書き込み.push(db.prepare('UPDATE screen_captures SET sifted_at = ?2 WHERE image_id = ?1').bind(capture.imageId, toIso(now)))
  await db.batch(書き込み)
}

/**
 * その配信で既に渡した行を、新しいほうから読む。
 *
 * 篩の3段目（既出の除去）が照らす相手になる。新しいほうを残すのは、いま映っている画面と照らすためである
 * （配信の序盤にしか出ていない行と照らしても、同じ画面を畳むのには効かない）。
 *
 * @param limit 読む件数の上限
 */
export const readRecentScreenLines = async (db: Database, sessionId: string, limit: number): Promise<string[]> => {
  const { results } = await db
    .prepare(
      `SELECT text FROM screen_lines
       WHERE session_id = ?1
       ORDER BY captured_at DESC, image_id DESC, line_no DESC
       LIMIT ?2`,
    )
    .bind(sessionId, limit)
    .all<{ text: string }>()
  return results.map((row) => row.text)
}

/** 画面に現れた1行と、それを撮った1枚の手がかり */
export interface ScreenLine {
  /** 画面に現れた文字 */
  readonly text: string
  /** 撮った時刻（UTCのISO 8601） */
  readonly at: string
  /** Gyazo が振った画像ID */
  readonly imageId: string
}

/**
 * どこまであらすじの材料にしたかの目印。
 *
 * 撮った時刻だけでは足りない。同じ時刻に撮った1枚が件数の上限で分かれると、残りが次からの
 * 「この時刻より後」に一度も入らず永久に漏れる。読む順（撮った時刻・画像IDの順）と同じ組で比べる
 * （worker/transcript-store.ts の TranscriptCursor と同じ理由）。
 *
 * 1枚の中の並び（line_no）は持たない。篩は1枚ぶんの行をまとめて積むので、材料にするのも1枚ぶん
 * まとめてであり、1枚の途中で切れることがないためである。
 */
export interface ScreenLineCursor {
  at: string
  imageId: string
}

/**
 * その配信で画面に現れた行のうち、まだあらすじの材料にしていないぶんを、現れた順に読む。
 *
 * あらすじ（worker/stream-summary.ts）は前回のあらすじに新しい材料を積み上げて書き直させるので、
 * 読むのは続きだけでよい（発話・発言と同じ形）。
 *
 * @param since この目印より後のぶんだけを読む。まだ一度もあらすじを作っていなければ、時刻も画像IDも
 *   空文字を渡す（どの値よりも小さいので全件が読める）
 * @param limit 読む件数の上限。超えたぶんは新しいほうを切り、次にあらすじを作るときへ回す
 *   （呼び出し側は読めた行の最後を目印として記録するため、取りこぼしにはならない）
 */
export const readScreenLinesSince = async (
  db: Database,
  sessionId: string,
  since: ScreenLineCursor,
  limit: number,
): Promise<ScreenLine[]> => {
  const { results } = await db
    .prepare(
      // 並べ替えと同じ組で比べる。片方だけで比べると、同じ時刻の1枚が目印の前後に分かれてしまう
      `SELECT text, captured_at AS at, image_id AS imageId FROM screen_lines
       WHERE session_id = ?1 AND (captured_at, image_id) > (?2, ?3)
       ORDER BY captured_at, image_id, line_no
       LIMIT ?4`,
    )
    .bind(sessionId, since.at, since.imageId, limit)
    .all<ScreenLine>()
  return results
}

/** いま画面に出ている文字の1行 */
export interface CurrentScreenLine {
  /** 画面に現れた文字 */
  readonly text: string
  /** 撮った時刻（UTCのISO 8601） */
  readonly at: string
}

/**
 * その配信で直近に画面に現れた行を、現れた順（古い順）に読む。
 *
 * サイドスーパー（worker/side-super.ts）の材料になる。あらすじと違って前回のものに積み上げないので、
 * 「どこまで材料にしたか」ではなく「いま画面に何が出ているか」だけが要る。そのため新しいほうから
 * limit 件を取り、LLMへ渡す向き（古い順）に直して返す（readRecentTranscripts と同じ形）。
 *
 * 撮った時刻を添えるのは、呼び出し側が「前回サイドスーパーを作ったあとに新しい行があるか」を
 * 判定するためである（無ければLLMを呼ばない）。
 *
 * @param limit 読む件数の上限。超えたぶんは古いほうから落とす
 */
export const readCurrentScreenLines = async (db: Database, sessionId: string, limit: number): Promise<CurrentScreenLine[]> => {
  const { results } = await db
    .prepare(
      `SELECT text, captured_at AS at FROM screen_lines
       WHERE session_id = ?1
       ORDER BY captured_at DESC, image_id DESC, line_no DESC
       LIMIT ?2`,
    )
    .bind(sessionId, limit)
    .all<CurrentScreenLine>()
  return results.reverse()
}

/**
 * HDAD 自身が配信画面に出している文字を読む。
 *
 * 篩の1段目（自前の文字の除去）が照らす相手になる。画面に映り込むのはサイドスーパー（side_supers）・
 * チャットボックス（stream_chat_messages と viewers.display_name）・字幕（transcripts）で、
 * どれも Worker が自分で持っているので、除外集合に入れるだけで済む。
 *
 * 注意: 新しいほうから読む。画面に映っているのは直近のぶんだけであり、配信の序盤の発言と照らしても
 * 落とせるものは増えないためである。
 *
 * @param limit 発言・発話それぞれについて読む件数の上限
 */
export const readOwnScreenTexts = async (db: Database, sessionId: string, limit: number): Promise<string[]> => {
  const sideSuper = await db
    .prepare('SELECT line1 AS text FROM side_supers WHERE session_id = ?1 UNION ALL SELECT line2 FROM side_supers WHERE session_id = ?1')
    .bind(sessionId)
    .all<{ text: string }>()
  const chat = await db
    .prepare(
      `SELECT m.text AS text, v.display_name AS display_name FROM stream_chat_messages m
       LEFT JOIN viewers v ON v.user_id = m.user_id
       WHERE m.session_id = ?1
       ORDER BY m.sent_at DESC, m.message_id DESC
       LIMIT ?2`,
    )
    .bind(sessionId, limit)
    .all<{ text: string; display_name: string | null }>()
  const transcripts = await db
    .prepare('SELECT text FROM transcripts WHERE session_id = ?1 ORDER BY spoken_at DESC, message_id DESC LIMIT ?2')
    .bind(sessionId, limit)
    .all<{ text: string }>()

  const 表示名 = chat.results.map((row) => row.display_name).filter((name): name is string => name !== null)
  return [...sideSuper.results, ...chat.results, ...transcripts.results].map((row) => row.text).concat(表示名)
}

/**
 * 期限より古い行を消す。
 *
 * 画面から取り出した行も、取り込みの記録（deleteOldScreenCaptures）と同じく配信中だけ持つものなので、
 * 同じ期限で同じように消す（配信中の区切りのぶんは残す）。
 *
 * @param before この時刻より前に撮った行を消す
 */
export const deleteOldScreenLines = async (db: Database, before: number): Promise<void> => {
  await db
    .prepare('DELETE FROM screen_lines WHERE captured_at < ?1 AND session_id NOT IN (SELECT id FROM stream_sessions WHERE ended_at IS NULL)')
    .bind(toIso(before))
    .run()
}
