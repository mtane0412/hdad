/**
 * テキストの読み書き
 *
 * 配信者が自由に書いた文字（合成ページの素材「テキスト」。issue #294）を migrations/0029_texts.sql の texts に1件1行で持つ。
 * 手動／自動の別・指示文・本文を誰が書いたかは migrations/0030_texts_auto.sql で足した列に持つ（issue #295）。
 * 検証は worker/text.ts が済ませたものだけを受け取り、ここでは確かめない。
 *
 * 注意: 自動のテキストの本文は、画面からの保存では書き換えない（画面が読み込んだときの古い本文で、LLM の新しい本文を上書きしないため）。
 * 注意: LLM の本文は、読んだあとに配信者が書き換えていない自動のテキストにだけ書く（saveGeneratedText。人が書いた文を機械が黙って上書きしない）。
 *
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。
 */
import type { Database } from './database'
import { MAX_TEXT_COUNT, duplicateNameError, type TextEntry, type TextInput, type TextMode, type TextWriter } from './text'

const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/** texts の1行 */
interface TextRow {
  id: number
  name: string
  body: string
  // 表の CHECK 制約が manual・auto（human・llm）以外を拒むので、読んだ値はこの型に収まる
  mode: TextMode
  instruction: string
  written_by: TextWriter
  updated_at: string
}

const COLUMNS = 'id, name, body, mode, instruction, written_by, updated_at'

const toEntry = (row: TextRow): TextEntry => ({
  id: row.id,
  name: row.name,
  body: row.body,
  mode: row.mode,
  instruction: row.instruction,
  writtenBy: row.written_by,
  updatedAt: row.updated_at,
})

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
 * 自動のテキストは本文を空で追加する（LLM が書くまで合成ページには映らない）。
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
        `INSERT INTO texts (name, body, mode, instruction, written_by, updated_at)
         SELECT ?1, ?2, ?3, ?4, 'human', ?5 WHERE (SELECT count(*) FROM texts) < ?6
         RETURNING ${COLUMNS}`,
      )
      .bind(input.name, input.mode === 'manual' ? input.body : '', input.mode, input.instruction, toIso(now), MAX_TEXT_COUNT)
      .first<TextRow>(),
  )
  return row === null ? null : toEntry(row)
}

/**
 * テキストの名前・手動／自動の別・指示文（手動なら本文も）を書き換える。
 *
 * 手動の保存で本文が変わったときだけ、本文を書いた人を配信者にする。LLM が書いた本文を変えずに手動へ戻しただけなら、
 * 機械の文を人が書いたことにしない（方針11）。自動の保存では本文も書いた人も変えない。
 *
 * @returns 書き換えたテキスト。そのIDのテキストが無ければ null
 * @throws ConfigError 名前がほかのテキストと重なった場合
 */
export const updateText = async (db: Database, id: number, input: TextInput, now: number): Promise<TextEntry | null> => {
  const statement =
    input.mode === 'manual'
      ? db
          .prepare(
            // SET の右辺の body・written_by は書き換える前の値を指す
            `UPDATE texts SET name = ?2, mode = 'manual', instruction = ?3, body = ?4,
               written_by = CASE WHEN body = ?4 THEN written_by ELSE 'human' END, updated_at = ?5
             WHERE id = ?1 RETURNING ${COLUMNS}`,
          )
          .bind(id, input.name, input.instruction, input.body, toIso(now))
      : db
          .prepare(`UPDATE texts SET name = ?2, mode = 'auto', instruction = ?3, updated_at = ?4 WHERE id = ?1 RETURNING ${COLUMNS}`)
          .bind(id, input.name, input.instruction, toIso(now))
  const row = await rejectingDuplicateName(input.name, () => statement.first<TextRow>())
  return row === null ? null : toEntry(row)
}

/**
 * LLM が書いた本文を、自動のテキストに書く（worker/collect.ts）。
 *
 * 本文を作るあいだ（LLM の呼び出しで数秒〜数十秒）に配信者がそのテキストを書き換えていたら書かない。読んだときの
 * 書き換えた時刻（expectedUpdatedAt）と同じで、まだ自動のときだけ書く（比べて書くまでを1つの文で行う）。
 *
 * @param expectedUpdatedAt 本文を作る前に読んだ、そのテキストの書き換えた時刻
 * @returns 書いたテキスト。配信者が書き換えた・手動にした・消した場合は null
 */
export const saveGeneratedText = async (db: Database, id: number, body: string, expectedUpdatedAt: string, now: number): Promise<TextEntry | null> => {
  const row = await db
    .prepare(
      `UPDATE texts SET body = ?2, written_by = 'llm', updated_at = ?3
       WHERE id = ?1 AND mode = 'auto' AND updated_at = ?4 RETURNING ${COLUMNS}`,
    )
    .bind(id, body, toIso(now), expectedUpdatedAt)
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
