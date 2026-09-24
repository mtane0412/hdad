/**
 * 配信中の文字起こしの読み書き
 *
 * OBSのブラウザソースに置いた中継ページ（transcript/index.html）が、同じPCで動いているゆかコネNEO の
 * 音声認識の結果を押し込んでくる（POST /api/overlay/transcript）。ここはその保存と読み出しだけを受け持つ。
 *
 * 貯めるのは配信中のぶんだけで、「途中から来た人向けのあらすじ」（issue #65）の材料にする。
 * チャットの本文を配信中だけ貯める stream-chat-store.ts と同じ考え方で、永く持つものではない。
 *
 * 注意: 記録するのは配信中の区切り（stream_sessions の ended_at IS NULL の行）があるときだけで、
 * 無ければ1行も書かない（stream_events・stream_chat_messages と同じ結びつけ方）。配信前のマイクの確認や
 * 配信後の独り言を貯めないためである。
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。
 */
import type { Database } from './database'

const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/** 記録する発話。中継ページが読み解いた値（src/transcript/message.ts）をそのまま受け取る */
export interface Transcript {
  /** ゆかコネNEO が振った MsgID。同じ発話を二度貯めないための鍵 */
  messageId: string
  /** 確定した発話の本文（母国語。翻訳は保存しない） */
  text: string
}

/**
 * 配信中の発話を記録する。配信していなければ1行も書かない。
 *
 * 注意: 配信中の区切りは INSERT ... SELECT の中で引く。「配信中かどうかを読んでから書く」に分けると
 * 読み出しが1回増えるうえ、その間に配信が終わると食い違う（stream_chat_messages と同じ考え方）。
 * 注意: 同じ MsgID で二度呼ばれても、どちらにも true を返す。中継ページ側でも送信済みの MsgID は覚えているが、
 * 送信が途中で失敗してやり直したときに「記録できなかった」と誤って知らせないためである
 * （claimFirstChatOfStream が再送に同じ答えを返すのと同じ考え方）。そのとき spoken_at は最初のまま残す。
 *
 * @returns 記録したなら true。配信していなくて捨てたなら false
 */
export const recordTranscript = async (db: Database, transcript: Transcript, now: number): Promise<boolean> => {
  const recorded = await db
    .prepare(
      // 配信中の行が無ければ SELECT が0行を返すので、INSERT も起きず RETURNING も何も返さない
      `INSERT INTO transcripts (message_id, session_id, spoken_at, text)
       SELECT ?1, id, ?2, ?3 FROM stream_sessions
       WHERE ended_at IS NULL AND started_at <= ?2
       ORDER BY started_at DESC LIMIT 1
       ON CONFLICT (message_id) DO UPDATE SET text = transcripts.text
       RETURNING message_id`,
    )
    .bind(transcript.messageId, toIso(now), transcript.text)
    .first<{ message_id: string }>()
  return recorded !== null
}

/**
 * 記録済みの発話を取り消す。
 *
 * ゆかコネNEO は、いったん確定した発話をあとから取り消すことがある（isDeleted）。あらすじの材料に
 * 取り消された発話が残らないよう、中継ページからの知らせに従って消す。
 *
 * @returns 消す行があったなら true
 */
export const deleteTranscript = async (db: Database, messageId: string): Promise<boolean> => {
  const deleted = await db
    .prepare('DELETE FROM transcripts WHERE message_id = ?1 RETURNING message_id')
    .bind(messageId)
    .first<{ message_id: string }>()
  return deleted !== null
}

/**
 * あらすじの材料として読み出した1件。
 *
 * 時刻とメッセージIDの両方を添えるのは、「どこまで材料にしたか」の記録に両方が要るためである
 * （readTranscriptsSince の since を参照）。
 */
export interface TranscriptLine {
  text: string
  /** 喋った日時（ISO 8601） */
  at: string
  /** ゆかコネNEO が振った MsgID */
  messageId: string
}

/**
 * どこまで材料にしたかの目印。
 *
 * 日時だけでは足りない。記録する時刻はWorkerが押し込みを受け取った時刻なので、立て続けに届いた
 * 2件が同じ時刻になることがあり、そこで件数の上限に当たると、残った同時刻の行が次からの
 * 「この日時より後」に一度も入らず、永久に材料から漏れる。読む順（日時・メッセージIDの順）と
 * 同じ組で比べて、その取りこぼしを防ぐ。
 */
export interface TranscriptCursor {
  at: string
  messageId: string
}

/**
 * その配信の発話のうち、まだあらすじの材料にしていないぶんを、喋った順に読む。
 *
 * あらすじ（issue #65）は前回のあらすじに新しい材料を積み上げて書き直させるので、読むのは続きだけでよい
 * （worker/stream-summary-store.ts）。毎回すべてを読ませると、長い配信ほど1回あたりの入力が膨らみ、
 * Workers AI の無料枠（Neurons）とD1の rows read の両方を食う。
 *
 * @param since この目印より後のぶんだけを読む。まだ一度もあらすじを作っていなければ、日時もメッセージIDも
 *   空文字を渡す（どの値よりも小さいので全件が読める）
 * @param limit 読む件数の上限。上限を超えたぶんは新しいほうを切り、次にあらすじを作るときへ回す
 *   （呼び出し側は読めた行の最後を目印として記録するため、取りこぼしにはならない）
 */
export const readTranscriptsSince = async (
  db: Database,
  sessionId: string,
  since: TranscriptCursor,
  limit: number,
): Promise<TranscriptLine[]> => {
  const { results } = await db
    .prepare(
      // 並べ替えと同じ組で比べる。片方だけで比べると、同じ日時の行が目印の前後に分かれてしまう
      `SELECT text, spoken_at AS at, message_id AS messageId FROM transcripts
       WHERE session_id = ?1 AND (spoken_at, message_id) > (?2, ?3)
       ORDER BY spoken_at, message_id
       LIMIT ?4`,
    )
    .bind(sessionId, since.at, since.messageId, limit)
    .all<TranscriptLine>()
  return results
}

/**
 * 期限より古い発話を消す。
 *
 * 文字起こしは配信中だけ持つものなので、終わった配信のぶんを残しておく意味はない。cron の収集のついでに呼ぶ
 * （first_chatters の掃除と同じ扱い）。
 *
 * 注意: 配信中の区切りのぶんは、期限より古くても消さない。期限より長く続く配信（耐久配信など）の
 * 途中で序盤の発話を消してしまうと、あらすじが配信の始まりを語れなくなる。
 *
 * @param before この時刻より前に喋った行を消す
 */
export const deleteOldTranscripts = async (db: Database, before: number): Promise<void> => {
  await db
    .prepare('DELETE FROM transcripts WHERE spoken_at < ?1 AND session_id NOT IN (SELECT id FROM stream_sessions WHERE ended_at IS NULL)')
    .bind(toIso(before))
    .run()
}

/**
 * その配信の直近の発話を、喋った順（古い順）に本文だけで読む。
 *
 * サイドスーパー（worker/side-super.ts）の材料になる。あらすじと違って前回のものに積み上げないので、
 * 「どこまで材料にしたか」ではなく「いま何を喋っているか」だけが要る。そのため新しいほうから
 * limit 件を取り、LLMへ渡す向き（古い順）に直して返す。
 *
 * 喋った時刻を添えるのは、呼び出し側が「前回サイドスーパーを作ったあとに新しい発話があるか」を
 * 判定するためである（無ければLLMを呼ばない）。
 *
 * @param limit 読む件数の上限。超えたぶんは古いほうから落とす
 */
export const readRecentTranscripts = async (db: Database, sessionId: string, limit: number): Promise<TranscriptLine[]> => {
  const { results } = await db
    .prepare(
      `SELECT text, spoken_at AS at, message_id AS messageId FROM transcripts
       WHERE session_id = ?1
       ORDER BY spoken_at DESC, message_id DESC
       LIMIT ?2`,
    )
    .bind(sessionId, limit)
    .all<TranscriptLine>()
  return results.reverse()
}
