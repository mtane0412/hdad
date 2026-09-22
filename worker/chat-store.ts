/**
 * チャットボットの状態の読み書き
 *
 * 「この通知にはもう応答したか」「このコマンドはクールダウン中か」「同じ文面が何件続いたか」
 * 「次にアナウンスを送ってよいのはいつか」をデータベース（D1）で持つ。
 * 最初の2つはコマンドに一致した発言のとき、3つ目は連投のルールが有効なときだけ書くので、チャットの全件は書かない。
 * テーブルの定義は migrations/0002_chat_bot.sql・0003_chat_moderation.sql・0004_announcement_slots.sql にある。
 * 日時は UTC の ISO 8601 の文字列で持つ。
 *
 * 注意: どの判定も SQLite の RETURNING を使い、1つの文の中で「書けたかどうか」を受け取る。
 * 「読んでから書く」に分けると、同時に届いた通知の間で判定が食い違う。
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。
 */
import type { Database } from './database'

/** 応答済みの鍵を残す期間（ミリ秒）。Twitchの再送は短時間に起きるので1時間で足りる */
const REPLY_RETENTION_MS = 60 * 60 * 1000
const MILLISECONDS_PER_SECOND = 1000

const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/**
 * この通知に応答してよいかを決め、応答するなら鍵を確保する。
 *
 * Twitchは応答が届かなかった通知を再送するため、これがないと同じ発言に二度応答してしまう。
 * あわせて、古い鍵（1時間より前）を消して増え続けないようにする。
 *
 * @returns 確保できれば true。既に応答済み（再送）なら false
 */
export const reserveChatReply = async (db: Database, messageId: string, now: number): Promise<boolean> => {
  await db.prepare('DELETE FROM replied_chat_messages WHERE replied_at < ?1').bind(toIso(now - REPLY_RETENTION_MS)).run()

  const reserved = await db
    .prepare(
      `INSERT INTO replied_chat_messages (message_id, replied_at) VALUES (?1, ?2)
       ON CONFLICT DO NOTHING
       RETURNING message_id`,
    )
    .bind(messageId, toIso(now))
    .first<{ message_id: string }>()
  return reserved !== null
}

/** 連投を数えるために記録する発言 */
export interface RecentMessage {
  /** Twitchが振ったメッセージのID。再送で同じ発言を二重に数えないための鍵 */
  messageId: string
  chatterUserId: string
  /** 本文。前後の空白と大文字小文字の違いは同じ文面として扱う */
  text: string
  /** 何秒さかのぼって数えるか（連投のルールの窓） */
  windowSeconds: number
}

/**
 * 本文を、連投の判定に使うハッシュ（SHA-256の16進）にする。
 *
 * 本文そのものをデータベースに置かないのは、数えるのに中身が要らないうえ、チャットの中身を貯め込まないため。
 * 前後の空白と大文字小文字をそろえてから計算するので、「うおお」と「 うおお 」は同じ文面として数える。
 */
const hashText = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.trim().toLowerCase()))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * この発言を記録し、同じ発言者が窓のあいだに送った同じ文面の件数を返す（この発言を含む）。
 *
 * 判定より先に自分の1件を書き込むのは、「読んでから書く」に分けると、同時に届いた通知の間で件数が食い違うため。
 * あわせて、窓より古い行を消して増え続けないようにする。
 *
 * 注意: 同じメッセージIDの行は増やさない（メッセージIDが主キー）。Twitchの再送で行が増えると、
 * 1回しか発言していない人を連投とみなして誤って処分してしまう。
 *
 * 注意: 呼び出し側は、連投のルールが有効なときだけこれを呼ぶ（チャットは件数の桁が違い、
 * 1通ごとに書くと配信の記録とD1の書き込みの枠を食い合う）。
 *
 * @returns 窓の中にある同じ文面の件数（必ず1以上。自分の1件を含む）
 */
export const recordAndCountRecentMessage = async (db: Database, message: RecentMessage, now: number): Promise<number> => {
  const since = toIso(now - message.windowSeconds * MILLISECONDS_PER_SECOND)
  const textHash = await hashText(message.text)

  await db.prepare('DELETE FROM chat_recent_messages WHERE sent_at < ?1').bind(since).run()
  await db
    .prepare(
      `INSERT INTO chat_recent_messages (message_id, chatter_user_id, text_hash, sent_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT DO NOTHING`,
    )
    .bind(message.messageId, message.chatterUserId, textHash, toIso(now))
    .run()

  const counted = await db
    .prepare('SELECT COUNT(*) AS count FROM chat_recent_messages WHERE chatter_user_id = ?1 AND text_hash = ?2 AND sent_at >= ?3')
    .bind(message.chatterUserId, textHash, since)
    .first<{ count: number }>()
  // 直前に自分の1件を書いているので、数えられないことはない。それでも欠けたなら「連投ではない」側へ倒す
  return counted?.count ?? 1
}

/**
 * コマンドのクールダウンを消費する。
 *
 * 消費できなかったとき（クールダウン中）は、最後に使った時刻を更新しない。
 * 更新してしまうと、連打されている間はいつまでもクールダウンが明けない。
 *
 * @param cooldownSeconds 続けて応答しない秒数。0 なら毎回消費できる
 * @returns 消費できれば true。クールダウン中なら false
 */
export const consumeCooldown = async (db: Database, commandName: string, cooldownSeconds: number, now: number): Promise<boolean> => {
  const usableBefore = toIso(now - cooldownSeconds * MILLISECONDS_PER_SECOND)
  const consumed = await db
    .prepare(
      `INSERT INTO command_uses (command_name, used_at) VALUES (?1, ?2)
       ON CONFLICT (command_name) DO UPDATE SET used_at = ?2 WHERE used_at <= ?3
       RETURNING command_name`,
    )
    .bind(commandName, toIso(now), usableBefore)
    .first<{ command_name: string }>()
  return consumed !== null
}

/** アナウンスを続けて送るときに空ける間隔（ミリ秒）。Twitchのアナウンスは2秒に1回しか送れない */
const ANNOUNCEMENT_INTERVAL_MS = 2000
/**
 * 枠を確保するときに受け入れる待ち時間の上限（ミリ秒）。
 *
 * 待つあいだTwitchのWebhookへの応答を返せないため、Twitchが応答を待つ時間（10秒）に対して十分短くしている。
 * これを超えるほど詰まっていれば、枠を確保せずに諦める（確保しないので、あとから届く通知を遅らせない）。
 */
const MAX_ANNOUNCEMENT_WAIT_MS = 4000

/** SQLiteの日時の書式を、TypeScript の toISOString と同じ形（ミリ秒3桁＋Z）にそろえるための指定 */
const SQLITE_ISO_FORMAT = '%Y-%m-%dT%H:%M:%fZ'

/**
 * アナウンスの送信枠を確保し、送るまでに待つ時間を返す。
 *
 * アナウンス（POST /helix/chat/announcements）は2秒に1回しか送れないため、別々のEventSub通知が
 * 2秒以内に続くと2通目が429で拒否されてしまう。そこで「次に送ってよい時刻」をデータベースに1行持ち、
 * 送る前にそれを2秒進めることで枠を確保する。呼び出し側は返ってきた時間だけ待ってから送る。
 *
 * 進めるのと同時に確保できたかを受け取るのは、consumeCooldown と同じく SQLite の RETURNING による。
 * 「読んでから書く」に分けると、同時に届いた別々の通知が同じ枠を確保してしまう。
 *
 * @param broadcasterId 送り先のチャンネル。アナウンスの制限はチャンネルごとなので、枠もチャンネルごとに持つ
 * @returns 送るまでに待つミリ秒（0 ならすぐ送れる）。待ち時間の上限を超えるほど詰まっていれば null
 */
export const reserveAnnouncementSlot = async (db: Database, broadcasterId: string, now: number): Promise<number | null> => {
  const reserved = await db
    .prepare(
      `INSERT INTO announcement_slots (broadcaster_id, next_available_at) VALUES (?1, ?2)
       ON CONFLICT (broadcaster_id) DO UPDATE
         SET next_available_at = strftime('${SQLITE_ISO_FORMAT}', MAX(next_available_at, ?3), '+${ANNOUNCEMENT_INTERVAL_MS / MILLISECONDS_PER_SECOND} seconds')
         WHERE next_available_at <= ?4
       RETURNING next_available_at`,
    )
    .bind(broadcasterId, toIso(now + ANNOUNCEMENT_INTERVAL_MS), toIso(now), toIso(now + MAX_ANNOUNCEMENT_WAIT_MS))
    .first<{ next_available_at: string }>()
  if (reserved === null) return null

  // 確保した枠の「次に送ってよい時刻」から間隔をさかのぼると、自分が送ってよい時刻になる
  const sendAt = Date.parse(reserved.next_available_at) - ANNOUNCEMENT_INTERVAL_MS
  return Math.max(0, sendAt - now)
}

/** 「その配信で初めての発言」の判定に要る、発言の識別 */
export interface FirstChatClaim {
  /** 発言者のユーザーID。配信の区切りごと・人ごとに1行持つ */
  chatterUserId: string
  /** 発言そのもののID（通知の event.message_id）。同じ発言への問い合わせに同じ答えを返すための鍵 */
  messageId: string
}

/**
 * この発言が「その配信で初めての発言」かを判定し、初めてなら記録する。
 *
 * 配信の区切りは stream_sessions の「配信中の行」（ended_at が NULL）で、recordEvent（stats-store.ts）と同じ引き方をする。
 * 配信中の行が無いとき（配信外の発言）は、初回と判定せず記録も残さない。テスト配信や配信前の雑談のたびに
 * アラートが鳴ってしまうのを防ぐためである。
 *
 * 注意: 判定と記録は1つの文で行う。「読んでから書く」に分けると、同時に届いた通知の間で判定が食い違う。
 * 注意: 配信の区切りは、通知に書かれた発生時刻ではなく受け取った時刻（now）で引く。発生時刻で引くほうが厳密に見えるが、
 * この判定はWebhookとオーバーレイの両方から呼ばれ、オーバーレイ（WebSocket）は信頼できる発生時刻を持たない。
 * 両者が別の時刻を使うと別の区切りの行を取り合うことになり、「同じ発言には同じ答えを返す」が成り立たなくなる。
 * 配信中の区切りは同時に1つしかない（recordStreamOnline がほかを閉じる）ので、受け取った時刻で引いても選ばれる区切りは同じである。
 * 注意: 同じ発言について二度問い合わせても、どちらにも true を返す（message_id が一致する行なら書き込み済みでも初回として扱う）。
 * この判定は Webhook（チャット・アナウンスの送信）とオーバーレイ（素材の再生）の両方から呼ばれ、同じ発言が
 * 別々の経路で届くため、先に問い合わせた側だけが初回になると片方の動作だけが実行されてしまう。
 *
 * @returns その配信で初めての発言なら true
 */
export const claimFirstChatOfStream = async (db: Database, claim: FirstChatClaim, now: number): Promise<boolean> => {
  const at = toIso(now)
  const claimed = await db
    .prepare(
      // INSERT ... SELECT にするのは、配信中の行が無ければ1行も書き込まずに済ませるため
      // （SELECT が0行を返すので INSERT も起きず、RETURNING も何も返さない）
      `INSERT INTO first_chatters (session_id, chatter_user_id, message_id, first_chatted_at)
       SELECT id, ?1, ?2, ?3 FROM stream_sessions WHERE ended_at IS NULL AND started_at <= ?3 ORDER BY started_at DESC LIMIT 1
       ON CONFLICT (session_id, chatter_user_id) DO UPDATE SET message_id = message_id
         WHERE first_chatters.message_id = ?2
       RETURNING message_id`,
    )
    .bind(claim.chatterUserId, claim.messageId, at)
    .first<{ message_id: string }>()
  return claimed !== null
}

/**
 * 期限より古い「初めての発言」の記録を消す。
 *
 * 配信の区切りが増えるほど行が積み上がるので、cron（worker/collect.ts）から定期的に呼ぶ。
 * 判定に使うのは配信中の区切りだけなので、終わった配信のぶんは残しておく意味がない。
 *
 * 注意: 配信中の区切りのぶんは、期限より古くても消さない。期限より長く続く配信（耐久配信など）の途中で消してしまうと、
 * すでに発言した人がまた「初回」と判定され、配信の途中でアラートが鳴り直してしまう。
 *
 * @param before この時刻より前に記録した行を消す
 */
export const deleteOldFirstChatters = async (db: Database, before: number): Promise<void> => {
  await db
    .prepare('DELETE FROM first_chatters WHERE first_chatted_at < ?1 AND session_id NOT IN (SELECT id FROM stream_sessions WHERE ended_at IS NULL)')
    .bind(toIso(before))
    .run()
}
