/**
 * テキストの読み書き
 *
 * 配信者が自由に書いた文字（合成ページの素材「テキスト」。issue #294）を migrations/0029_texts.sql の texts に1件1行で持つ。
 * 検証は worker/text.ts が済ませたものだけを受け取り、ここでは確かめない。
 *
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。
 */
import type { Database } from './database'
import { MAX_TEXT_COUNT, duplicateNameError, type TextEntry, type TextInput } from './text'

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

/** 名前の重なりを表の制約が拒んだときの文言（D1 も SQLite も同じ文言を含む） */
const NAME_CONFLICT = 'UNIQUE constraint failed: texts.name'

/**
 * 書き込みを実行し、名前の重なりを表の制約が拒んだら、名前の問題点（ConfigError）にする。
 *
 * 検証（worker/text.ts）は書く前に読んだ一覧で名前の重なりを見るが、そのあいだに別の窓が同じ名前を書くと表の制約で失敗する。
 * そのときも500ではなく、検証と同じ問題点で返す。ほかの失敗はそのまま投げる。
 */
const rejectingDuplicateName = async <T>(name: string, write: () => Promise<T>): Promise<T> => {
  try {
    return await write()
  } catch (error) {
    if (error instanceof Error && error.message.includes(NAME_CONFLICT)) throw duplicateNameError(name)
    throw error
  }
}

/** テキストをすべて、追加した順に読む */
export const readTexts = async (db: Database): Promise<TextEntry[]> => {
  const { results } = await db.prepare(`SELECT ${COLUMNS} FROM texts ORDER BY id`).all<TextRow>()
  return results.map(toEntry)
}

/**
 * テキストを1件追加する。持てる数（MAX_TEXT_COUNT）に達していたら追加しない。
 *
 * 件数の確認と追加は1つの文で行う（「数えてから追加する」に分けると、並んだ追加がどちらも確認を通って上限を超えるため）。
 *
 * @returns 追加したテキスト（振られたIDを含む）。持てる数に達していて追加しなかったなら null
 * @throws ConfigError 名前がほかのテキストと重なった場合
 */
export const insertText = async (db: Database, input: TextInput, now: number): Promise<TextEntry | null> => {
  const row = await rejectingDuplicateName(input.name, () =>
    db
      .prepare(
        // 上限に達していれば SELECT が0行を返すので、INSERT も起きず RETURNING も何も返さない
        `INSERT INTO texts (name, body, updated_at)
         SELECT ?1, ?2, ?3 WHERE (SELECT count(*) FROM texts) < ?4
         RETURNING ${COLUMNS}`,
      )
      .bind(input.name, input.body, toIso(now), MAX_TEXT_COUNT)
      .first<TextRow>(),
  )
  return row === null ? null : toEntry(row)
}

/**
 * テキストの名前と本文を書き換える。
 *
 * @returns 書き換えたテキスト。そのIDのテキストが無ければ null
 * @throws ConfigError 名前がほかのテキストと重なった場合
 */
export const updateText = async (db: Database, id: number, input: TextInput, now: number): Promise<TextEntry | null> => {
  const row = await rejectingDuplicateName(input.name, () =>
    db
      .prepare(`UPDATE texts SET name = ?2, body = ?3, updated_at = ?4 WHERE id = ?1 RETURNING ${COLUMNS}`)
      .bind(id, input.name, input.body, toIso(now))
      .first<TextRow>(),
  )
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
