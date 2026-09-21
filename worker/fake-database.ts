/**
 * テスト用のメモリ上のデータベース
 *
 * D1の代わりに Node.js 組み込みのSQLite（node:sqlite）で動かす。migrations/ のSQLをそのまま適用するので、
 * テーブルの定義とSQLの両方を本物に近い形で確かめられる。Worker のテストだけが使う（プロダクションコードからは参照しない）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { Database, DatabaseStatement, DatabaseValue } from './database'

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url)

/** fake が作った文だけが持つ、同期での実行 */
interface FakeStatement extends DatabaseStatement {
  runSync(): void
}

const isFakeStatement = (statement: DatabaseStatement): statement is FakeStatement => 'runSync' in statement

/** 中身を直接確かめられるよう、SQLite の本体も一緒に返す */
export const createFakeDatabase = (): Database & { sqlite: DatabaseSync } => {
  const sqlite = new DatabaseSync(':memory:')
  for (const fileName of readdirSync(MIGRATIONS_DIR).sort()) {
    sqlite.exec(readFileSync(new URL(fileName, MIGRATIONS_DIR), 'utf8'))
  }

  const createStatement = (sql: string, values: DatabaseValue[]): FakeStatement => ({
    bind: (...bound) => createStatement(sql, bound),
    runSync: () => {
      sqlite.prepare(sql).run(...values)
    },
    run: async () => {
      sqlite.prepare(sql).run(...values)
    },
    // D1と同じく、行の形は呼び出し側の申告をそのまま信じる
    all: async <Row>() => ({ results: sqlite.prepare(sql).all(...values) as Row[] }),
    first: async <Row>() => (sqlite.prepare(sql).get(...values) as Row | undefined) ?? null,
  })

  return {
    sqlite,
    prepare: (sql) => createStatement(sql, []),
    batch: async (statements) => {
      sqlite.exec('BEGIN')
      try {
        for (const statement of statements) {
          if (!isFakeStatement(statement)) throw new Error('fake-database が作った文だけを batch に渡せます')
          statement.runSync()
        }
        sqlite.exec('COMMIT')
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  }
}
