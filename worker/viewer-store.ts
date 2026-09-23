/**
 * 視聴者ごとの記録の読み書き
 *
 * チャットで発言した人を1人1行で持ち（migrations/0006_viewers.sql の viewers）、配信者が振り返れるようにする。
 * 発言そのものは貯めない。貯めるのは人で、1人1行なので数千人でも数MBに収まり、消さずに持ち続けられる。
 *
 * 記録の入口は webhook-routes.ts のチャットの受け口だけで、読み出しと書き換え（メモ・削除）は viewer-routes.ts が受け持つ。
 * この記録は、トリガーの条件「このチャンネルで初めての発言」「前の発言から空いた日数」の判定にも使う（readChatHistory）。
 * 日時は UTC の ISO 8601 の文字列で持つ。
 *
 * 注意: 発言のたびに書くとD1の書き込みの枠を食うので、前回の記録から UPDATE_INTERVAL_MS が空くまでは書き込まない
 * （条件に合わない行は0行と数えられる）。そのぶん message_count は「一定時間ごとの発言のかたまり」の数になる。
 * 注意: 記録と判定は1つの文で行う（INSERT ... ON CONFLICT DO UPDATE）。chat-store.ts と同じ考え方で、
 * 「読んでから書く」に分けると、同時に届いた通知の間で判定が食い違う。
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。
 */
import type { Database, DatabaseValue } from './database'
import { deleteAllStreamChatMessages } from './stream-chat-store'

/** 同じ人の記録を更新する間隔（ミリ秒）。これより短い間隔で届いた発言では1行も書き込まない */
const UPDATE_INTERVAL_MS = 10 * 60 * 1000

/** 一覧の既定の件数。呼び出し側が指定しなければこの件数を返す */
export const VIEWER_LIST_LIMIT = 50

/** 一覧で一度に返せる件数の上限。D1の rows read を食い過ぎないための歯止め */
export const VIEWER_LIST_MAX_LIMIT = 200

/**
 * ログイン名の前方一致の上限。Unicodeで最も大きい符号位置なので、
 * どの名前も「前方一致の語 + この文字」より小さくなる（`login >= 語 AND login < 語+この文字` が前方一致と同じ意味になる）。
 *
 * LIKE '語%' ではなく大小比較にするのは、索引（viewers_login）を確実に使わせるためである。
 */
const PREFIX_UPPER_BOUND = '\u{10FFFF}'

const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/** 記録する発言。通知から取り出した値（chat-command.ts の ChatMessage）を組み替えて渡す */
export interface ViewerMessage {
  /** 発言者のユーザーID。名前は本人が変えられるので、これだけを鍵にする */
  userId: string
  login: string
  displayName: string
  /** 発言者に付いていたバッジの種類の名前。最後に見た値として記録する */
  badges: readonly string[]
  /** Twitchが振ったメッセージのID。再送で発言数を二重に増やさないための鍵 */
  messageId: string
}

/** 一覧に出す、1人ぶんの記録 */
export interface Viewer {
  userId: string
  login: string
  displayName: string
  /** このチャンネルで初めて発言した日時（ISO 8601） */
  firstSeenAt: string
  /** 最後に発言した日時（ISO 8601） */
  lastSeenAt: string
  /** 通算の発言数（更新の間隔を空けているので、実際の発言数より少なくなる。おおよその数として扱う） */
  messageCount: number
  /** 最後に見たバッジの種類の名前 */
  badges: string[]
  /** 配信者が手で書いたメモ */
  note: string
  /**
   * LLMが配信中の発言から作った人物像（worker/viewer-summary.ts）。まだ作っていない人では空文字。
   *
   * 配信者が書いた note とは別に持つ。機械の推測と人が書いたものを混ぜないためである（画面でも別々に出す）。
   */
  summary: string
  /** その人物像を作った日時（ISO 8601）。まだ作っていない人では null */
  summarizedAt: string | null
}

/** 一覧の絞り込み */
export interface ViewerQuery {
  /** ログイン名の前方一致（大文字小文字は区別しない）。空や未指定なら絞り込まない */
  loginPrefix?: string
  /** この日時（ISO 8601）より前に発言した人だけを返す。続きを読むときの目印に使う */
  before?: string
  /**
   * `before` と同じ日時に発言した人のうち、どこまで返したかの目印（そのユーザーID）。
   *
   * チャットが活発なときは別々の人の発言が同じミリ秒に記録されうるので、日時だけを目印にすると、
   * 同じ日時の人がページの境目にまたがったときに取りこぼす（次のページの「その日時より前」に入らない）。
   */
  beforeUserId?: string
  /** 返す件数（既定 VIEWER_LIST_LIMIT、上限 VIEWER_LIST_MAX_LIMIT） */
  limit?: number
}

/** データベースから読んだ行。バッジはカンマ区切りの文字列で入っている */
interface ViewerRow extends Omit<Viewer, 'badges'> {
  badges: string
}

/**
 * 発言を受けて、その人の記録を作る（初めてなら）か更新する。
 *
 * bot自身の発言では呼ばない（呼び出し側が確かめる）。処分した発言では呼ぶ（荒らしの履歴も配信者には有用なため）。
 *
 * 注意: 前回の記録から UPDATE_INTERVAL_MS が空いていなければ、1行も書き込まない。
 * このとき login・display_name・last_badges も据え置きになるが、どれも「最後に見た値」なので困らない。
 * 注意: 直前に記録した発言のIDと同じなら更新しない。Twitchが再送した通知で発言数が二重に増えるのを防ぐためである。
 * ただし控えているのは直前の1件だけなので、防げるのは「最後に記録した発言」の再送までである。間隔を空けるために
 * 書き込まなかった発言が、10分より後に再送されて届いた場合は、新しい発言として1回数えられる。
 * すべての発言のIDを控えれば正確になるが、それには発言のたびに書き込みが要り、間隔を空ける意味が無くなる。
 * message_count はもともと数え落とすことを承知のうえでの概数なので、この取りこぼしは許す。
 */
export const recordViewerMessage = async (db: Database, message: ViewerMessage, now: number): Promise<void> => {
  const at = toIso(now)
  await db
    .prepare(
      // 初めての発言で作る行は first_message_id にその発言のIDを入れ、更新では last_seen_at を上書きする前の値を
      // previous_seen_at へ退避する（どちらも readChatHistory の判定に使う。DO UPDATE の中の viewers.列 は更新前の値を指す）
      `INSERT INTO viewers (user_id, login, display_name, first_seen_at, last_seen_at, message_count, last_badges, last_message_id, first_message_id, previous_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?4, 1, ?5, ?6, ?6, NULL)
       ON CONFLICT (user_id) DO UPDATE
         SET login = ?2, display_name = ?3, previous_seen_at = viewers.last_seen_at, last_seen_at = ?4,
             message_count = viewers.message_count + 1, last_badges = ?5, last_message_id = ?6
         WHERE viewers.last_message_id <> ?6 AND viewers.last_seen_at <= ?7`,
    )
    .bind(message.userId, message.login, message.displayName, at, message.badges.join(','), message.messageId, toIso(now - UPDATE_INTERVAL_MS))
    .run()
}

/** 発言の間隔を日数で表すための1日のミリ秒 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 「このチャンネルで初めての発言か」「最後の発言から何日空いているか」の判定に要る記録 */
interface ChatHistoryRow {
  firstMessageId: string
  lastMessageId: string
  lastSeenAt: string
  previousSeenAt: string | null
}

/** readChatHistory が返す、その発言についての履歴の判定 */
export interface ChatHistory {
  /** このチャンネルで初めての発言か */
  firstChatEver: boolean
  /** その発言が、前の発言から何日空いていたか。初めての発言なら null（丸めていないので小数になる） */
  daysSinceLastChat: number | null
}

/**
 * その発言について、「このチャンネルで初めてか」と「前の発言から何日空いていたか」を読む。
 *
 * 書き込みはしない（記録は recordViewerMessage が行う）。トリガーの条件（firstChatEver・returningAfter）の
 * 判定に使うため、呼ぶのは worker/alert-state.ts の resolveConditionState だけである。
 *
 * 注意: recordViewerMessage でその発言を記録したあとに呼ぶ前提で書いてある（Webhookの受け口が記録を先に済ませる）。
 * 記録したあとは last_seen_at がその発言の時刻に変わっているため、間隔は退避した previous_seen_at から数える。
 * 注意: 同じ発言について何度呼んでも同じ答えを返す。Twitchは同じ通知を再送することがあり、再送で答えが変わると、
 * 1通目の処理が途中で失敗していた場合にアラートが鳴らなくなる（chat-store.ts の claimFirstChatOfStream と同じ考え方）。
 * - 初めての発言は、その発言で作った行の first_message_id が一致することで分かる
 * - 間隔は、記録を更新した発言（last_message_id が一致する）なら退避した previous_seen_at から last_seen_at まで、
 *   記録しなかった発言（間隔を空けるために書き込まなかったもの）なら last_seen_at から now までを数える。
 *   後者を now まで数えるのは、久しぶりの発言に続く連投で、同じ間隔を何度も当てはめないためである
 * 注意: 0007 の列を足す前からある行は first_message_id が空文字、previous_seen_at が NULL である。
 * 空文字はどの発言のIDとも一致しないので「初めてではない」と判定され、間隔は last_seen_at から数えられる。
 */
export const readChatHistory = async (db: Database, message: Pick<ViewerMessage, 'userId' | 'messageId'>, now: number): Promise<ChatHistory> => {
  const row = await db
    .prepare(
      `SELECT first_message_id AS firstMessageId, last_message_id AS lastMessageId, last_seen_at AS lastSeenAt, previous_seen_at AS previousSeenAt
       FROM viewers WHERE user_id = ?1`,
    )
    .bind(message.userId)
    .first<ChatHistoryRow>()
  if (row === null || row.firstMessageId === message.messageId) return { firstChatEver: true, daysSinceLastChat: null }

  const [from, to] = row.lastMessageId === message.messageId ? [row.previousSeenAt, Date.parse(row.lastSeenAt)] : [row.lastSeenAt, now]
  // 退避した時刻を持たない行（0007 より前からある行の、記録を作った発言の再送）では間隔が分からない
  if (from === null) return { firstChatEver: false, daysSinceLastChat: null }
  return { firstChatEver: false, daysSinceLastChat: (to - Date.parse(from)) / DAY_MS }
}

/** カンマ区切りで持っているバッジを配列に戻す。1つも付いていなければ空文字列なので、空の配列にする */
const readBadges = (badges: string): string[] => (badges === '' ? [] : badges.split(','))

/**
 * 記録のある人を、最後に発言した順（新しい順）に返す。
 *
 * 件数が多くなるので全件は返さず、`before`（と `beforeUserId`）と `limit` で少しずつ読む。名前での絞り込みを
 * 前方一致にしているのは、部分一致（LIKE '%...%'）だと索引が効かず全件走査になり、D1の rows read を食うためである。
 *
 * 注意: 並び順にユーザーIDを添えるのは、最後の発言日時が同じ人どうしの順番を決めるためである。
 * 順番が定まらないと、同じ日時の人がページの境目にまたがったときに、続きを読んでも出てこない人が生じる。
 */
export const listViewers = async (db: Database, query: ViewerQuery): Promise<Viewer[]> => {
  const conditions: string[] = []
  const values: DatabaseValue[] = []

  // Twitchのログイン名は小文字なので、検索の語を小文字にそろえれば大文字で検索しても当てられる
  const prefix = query.loginPrefix?.toLowerCase() ?? ''
  if (prefix !== '') {
    conditions.push(`login >= ?${values.length + 1} AND login < ?${values.length + 2}`)
    values.push(prefix, prefix + PREFIX_UPPER_BOUND)
  }
  if (query.before !== undefined && query.before !== '') {
    // 同じ日時の人は、ユーザーIDの降順（並び順と同じ）で「目印より後ろ」だけを続きとして取る
    if (query.beforeUserId !== undefined && query.beforeUserId !== '') {
      conditions.push(`(last_seen_at < ?${values.length + 1} OR (last_seen_at = ?${values.length + 1} AND user_id < ?${values.length + 2}))`)
      values.push(query.before, query.beforeUserId)
    } else {
      conditions.push(`last_seen_at < ?${values.length + 1}`)
      values.push(query.before)
    }
  }
  values.push(Math.min(query.limit ?? VIEWER_LIST_LIMIT, VIEWER_LIST_MAX_LIMIT))

  const { results } = await db
    .prepare(
      `SELECT user_id AS userId, login, display_name AS displayName, first_seen_at AS firstSeenAt,
              last_seen_at AS lastSeenAt, message_count AS messageCount, last_badges AS badges, note,
              summary, summarized_at AS summarizedAt
       FROM viewers
       ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY last_seen_at DESC, user_id DESC
       LIMIT ?${values.length}`,
    )
    .bind(...values)
    .all<ViewerRow>()
  return results.map((row) => ({ ...row, badges: readBadges(row.badges) }))
}

/**
 * ユーザーIDで、その人ひとりの記録を読む。
 *
 * LLMに文面を作らせる動作（worker/ai-chat.ts）が、その人のメモと来訪の履歴を材料に渡すために呼ぶ。
 * その動作を持つトリガーが当てはまったときだけ呼ばれるので、発言のたびの読み出しにはならない。
 *
 * @returns 記録のある人の記録。まだ記録のない人なら null
 */
export const readViewer = async (db: Database, userId: string): Promise<Viewer | null> => {
  const row = await db
    .prepare(
      `SELECT user_id AS userId, login, display_name AS displayName, first_seen_at AS firstSeenAt,
              last_seen_at AS lastSeenAt, message_count AS messageCount, last_badges AS badges, note,
              summary, summarized_at AS summarizedAt
       FROM viewers WHERE user_id = ?1`,
    )
    .bind(userId)
    .first<ViewerRow>()
  return row === null ? null : { ...row, badges: readBadges(row.badges) }
}

/**
 * 配信者が書いたメモを書き換える。
 *
 * @returns 記録のある人なら true。無ければ false（呼び出し側が404にする）
 */
export const updateViewerNote = async (db: Database, userId: string, note: string): Promise<boolean> => {
  const updated = await db
    .prepare('UPDATE viewers SET note = ?2 WHERE user_id = ?1 RETURNING user_id')
    .bind(userId, note)
    .first<{ user_id: string }>()
  return updated !== null
}

/**
 * LLMが作った人物像を書き換える。
 *
 * 配信が終わったあとに cron（worker/collect.ts）が呼ぶ。配信者が書いた note は触らない。
 *
 * @returns 記録のある人なら true。無ければ false（記録を消した直後に人物像だけ書き込まないための確認）
 */
export const updateViewerSummary = async (db: Database, userId: string, summary: string, now: number): Promise<boolean> => {
  const updated = await db
    .prepare('UPDATE viewers SET summary = ?2, summarized_at = ?3 WHERE user_id = ?1 RETURNING user_id')
    .bind(userId, summary, toIso(now))
    .first<{ user_id: string }>()
  return updated !== null
}

/**
 * 人ごとの記録を消す。本人から求められたときに応じられるようにするためのもの。
 *
 * 注意: まだ人物像にしていない発言の本文（stream_chat_messages）も、配信中のぶんまで含めて一緒に消す。
 * 残すと、記録を消したあとも本文が手元に残り続けてしまう（本文はもともと人物像を作るまでの一時的なものである）。
 * 記録が無い人でも消すのは、記録だけを先に消したあとに届いた発言の本文を残さないためである。
 *
 * @returns 記録のある人なら true。無ければ false（呼び出し側が404にする）
 */
export const deleteViewer = async (db: Database, userId: string): Promise<boolean> => {
  const deleted = await db.prepare('DELETE FROM viewers WHERE user_id = ?1 RETURNING user_id').bind(userId).first<{ user_id: string }>()
  await deleteAllStreamChatMessages(db, userId)
  return deleted !== null
}
