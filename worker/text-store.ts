/**
 * テキストの読み書き
 *
 * 配信者が自由に書いた文字（合成ページの素材「テキスト」。issue #294）を migrations/0029_texts.sql の texts に1件1行で持つ。
 * 検証は worker/text.ts が済ませたものだけを受け取り、ここでは確かめない。
 *
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。
 */
import type { Database } from './database'
import type { TextEntry, TextInput } from './text'

const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/** texts の1行 */
interface TextRow {
  id: number
  name: string
  body: string
  updated_at: string
}

const COLUMNS = 'id, name, body, updated_at'

const toEntry = (row: TextRow): TextEntry => ({ id: row.id, name: row.name, body: row.body, updatedAt: row.updated_at })

/** テキストをすべて、追加した順に読む */
export const readTexts = async (db: Database): Promise<TextEntry[]> => {
  const { results } = await db.prepare(`SELECT ${COLUMNS} FROM texts ORDER BY id`).all<TextRow>()
  return results.map(toEntry)
}

/**
 * テキストを1件追加する。
 *
 * @returns 追加したテキスト（振られたIDを含む）
 */
export const insertText = async (db: Database, input: TextInput, now: number): Promise<TextEntry> => {
  const row = await db
    .prepare(`INSERT INTO texts (name, body, updated_at) VALUES (?1, ?2, ?3) RETURNING ${COLUMNS}`)
    .bind(input.name, input.body, toIso(now))
    .first<TextRow>()
  if (row === null) throw new Error('追加したテキストを読み返せませんでした')
  return toEntry(row)
}

/**
 * テキストの名前と本文を書き換える。
 *
 * @returns 書き換えたテキスト。そのIDのテキストが無ければ null
 */
export const updateText = async (db: Database, id: number, input: TextInput, now: number): Promise<TextEntry | null> => {
  const row = await db
    .prepare(`UPDATE texts SET name = ?2, body = ?3, updated_at = ?4 WHERE id = ?1 RETURNING ${COLUMNS}`)
    .bind(id, input.name, input.body, toIso(now))
    .first<TextRow>()
  return row === null ? null : toEntry(row)
}

/**
 * テキストを消す。
 *
 * @returns 消したなら true。そのIDのテキストが無ければ false
 */
export const deleteText = async (db: Database, id: number): Promise<boolean> => {
  const row = await db.prepare('DELETE FROM texts WHERE id = ?1 RETURNING id').bind(id).first<{ id: number }>()
  return row !== null
}
