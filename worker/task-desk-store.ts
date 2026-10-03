/**
 * 作業机の読み書き
 *
 * 視聴者の作業の宣言を migrations/0024_task_declarations.sql の task_declarations に配信ごと1人1行で残し、
 * 合成ページの素材「作業机」へ押し出す一覧と、開き直したときに取り戻す一覧を読む（issue #207）。
 *
 * 注意: 残すのは配信中の宣言だけで、配信中の区切りは INSERT ... SELECT の中で引く
 * （「配信中かどうかを読んでから書く」に分けると、その間に配信が終わったときに食い違う。dev_events と同じ考え方）。
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。
 */
import type { Database } from './database'
import type { TaskDeskEntry } from './task-desk'

const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/** いま配信中の配信。stream_sessions の配信中の区切り（ended_at が NULL）のうち、いちばん新しいもの */
const CURRENT_SESSION = 'SELECT id FROM stream_sessions WHERE ended_at IS NULL AND started_at <= ?1 ORDER BY started_at DESC LIMIT 1'

/** 残す宣言（時刻と配信は残すときに決まる） */
export interface TaskDeclarationInput {
  readonly userId: string
  /** 作業机に出す名前（発言者の表示名） */
  readonly name: string
  readonly task: string
  /** 宣言した発言（!task）のID */
  readonly messageId: string
}

/** 完了にする !done */
export interface TaskCompletionInput {
  readonly userId: string
  /** !done の発言のID。同じ発言の再送を見分けるのに使う */
  readonly messageId: string
}

/** 完了にした結果。already-done は、もう完了している宣言に重ねて !done が届いたときと、処理済みの !done が再送されたとき */
export type CompleteResult = 'completed' | 'already-done' | 'no-task' | 'offline'

/** モデレーションで消されたもの。1件の発言・ある人の発言すべて・チャット全体（worker/comment-feed.ts の FeedItem と同じ形） */
export type ModerationTarget = { readonly kind: 'delete'; readonly messageId: string } | { readonly kind: 'clearUser'; readonly userId: string } | { readonly kind: 'clear' }

/**
 * いまの配信の作業机に、宣言を残す。
 *
 * 同じ人がもう宣言していれば、作業と宣言した時刻を差し替えて完了を外す（1人1件）。ただし同じ発言の再送では
 * 宣言した時刻も完了も変えない（再送のあいだに !done していたら、完了が外れてしまうため）。
 *
 * @returns 残したなら true。配信していなくて残さなかったなら false
 */
export const declareTask = async (db: Database, declaration: TaskDeclarationInput, now: number): Promise<boolean> => {
  const row = await db
    .prepare(
      // 配信中の行が無ければ SELECT が0行を返すので、INSERT も起きず RETURNING も何も返さない。
      // WHERE true は、SELECT のあとの ON CONFLICT を結合の条件と読み違えさせないために SQLite が求めるもの
      `INSERT INTO task_declarations (session_id, user_id, display_name, task, message_id, declared_at, done_at)
       SELECT id, ?2, ?3, ?4, ?5, ?1, NULL FROM (${CURRENT_SESSION}) WHERE true
       ON CONFLICT (session_id, user_id) DO UPDATE SET
         display_name = excluded.display_name,
         task = excluded.task,
         declared_at = iif(task_declarations.message_id = excluded.message_id, task_declarations.declared_at, excluded.declared_at),
         done_at = iif(task_declarations.message_id = excluded.message_id, task_declarations.done_at, NULL),
         message_id = excluded.message_id
       RETURNING user_id`,
    )
    .bind(toIso(now), declaration.userId, declaration.name, declaration.task, declaration.messageId)
    .first<{ user_id: string }>()
  return row !== null
}

/**
 * いまの配信の、その人の宣言を完了にする。
 *
 * もう完了している宣言の完了の時刻は変えない（打ち直しで祝い直したり並びを変えたりしない）。
 * 処理済みの !done が再送されたら何もしない。再送までのあいだに打ち直した新しい宣言を、前の !done で完了にしないためである。
 * 処理済みかどうかは、!done の発言のIDに ':taskDone' を付けた鍵を replied_chat_messages に残して見分ける。
 * 完了と鍵の記録は1つのトランザクションで行う（完了だけが失敗して鍵が残ると、Twitch の再送で完了し直せなくなるため）。
 */
export const completeTask = async (db: Database, completion: TaskCompletionInput, now: number): Promise<CompleteResult> => {
  const session = await db.prepare(CURRENT_SESSION).bind(toIso(now)).first<{ id: string }>()
  if (session === null) return 'offline'

  const readDoneAt = async (): Promise<{ doneAt: string | null } | null> =>
    db
      .prepare('SELECT done_at AS doneAt FROM task_declarations WHERE session_id = ?1 AND user_id = ?2')
      .bind(session.id, completion.userId)
      .first<{ doneAt: string | null }>()
  const before = await readDoneAt()
  if (before === null) return 'no-task'
  if (before.doneAt !== null) return 'already-done'

  const key = `${completion.messageId}:taskDone`
  await db.batch([
    // 鍵の記録より先に完了させる。鍵がまだ無いとき（初めて届いた !done）だけ当てはまる
    db
      .prepare(
        `UPDATE task_declarations SET done_at = ?3
         WHERE session_id = ?1 AND user_id = ?2 AND done_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM replied_chat_messages WHERE message_id = ?4)`,
      )
      .bind(session.id, completion.userId, toIso(now), key),
    db.prepare('INSERT INTO replied_chat_messages (message_id, replied_at) VALUES (?1, ?2) ON CONFLICT DO NOTHING').bind(key, toIso(now)),
  ])

  // 未完了の行があって鍵が新しければ必ず完了するので、未完了のまま残っているのは処理済みの !done の再送のときだけである
  const after = await readDoneAt()
  return after === null || after.doneAt === null ? 'already-done' : 'completed'
}

/**
 * いまの配信の作業机を、上限の人数まで読む。
 *
 * 未完了の人を宣言の新しい順に並べ、そのあとに完了した人を完了の新しい順に並べる。上限を超えたら完了した人から落とし、
 * 作業中の人を押し出さない。時刻が同じならユーザーIDで決める（読み直すたびに並びが入れ替わらないため）。
 *
 * @returns 配信していなければ空の一覧（配信の前後にOBSを開いたままにするのが普通なので、失敗にしない）
 */
export const readTaskDesk = async (db: Database, now: number, limit: number): Promise<TaskDeskEntry[]> => {
  const { results } = await db
    .prepare(
      `SELECT user_id AS userId, display_name AS name, task, declared_at AS declaredAt, done_at AS doneAt
       FROM task_declarations WHERE session_id = (${CURRENT_SESSION})
       ORDER BY done_at IS NOT NULL, coalesce(done_at, declared_at) DESC, user_id
       LIMIT ?2`,
    )
    .bind(toIso(now), limit)
    .all<TaskDeskEntry>()
  return results
}

/**
 * モデレーションで消されたものに当たる宣言を、いまの配信の作業机から消す。
 *
 * 荒らしの書いた作業を配信画面に残さないためである（docs/decisions/focus.md の「モデレーションされたものは配信画面に残さない」と同じ考え方）。
 * 1件の発言が消されたときは、その発言で宣言した行だけを消す（打ち直したあとに前の宣言の発言が消されても、いまの宣言は残す）。
 * 終わった配信の宣言は消さない（作業した時間の記録として残っている配信を書き換えない）。
 *
 * @returns 1行でも消したなら true（作業机が変わったので押し出し直す）
 */
export const removeModeratedTasks = async (db: Database, target: ModerationTarget, now: number): Promise<boolean> => {
  const statement = (() => {
    const inCurrentSession = `DELETE FROM task_declarations WHERE session_id = (${CURRENT_SESSION})`
    switch (target.kind) {
      case 'delete':
        return db.prepare(`${inCurrentSession} AND message_id = ?2 RETURNING user_id`).bind(toIso(now), target.messageId)
      case 'clearUser':
        return db.prepare(`${inCurrentSession} AND user_id = ?2 RETURNING user_id`).bind(toIso(now), target.userId)
      case 'clear':
        return db.prepare(`${inCurrentSession} RETURNING user_id`).bind(toIso(now))
    }
  })()
  const { results } = await statement.all<{ user_id: string }>()
  return results.length > 0
}
