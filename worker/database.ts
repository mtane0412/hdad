/**
 * 配信の記録の保存先
 *
 * 実体は Cloudflare D1（wrangler.jsonc の DB）。Workerのコードが使う範囲だけを型として宣言し、
 * テストではメモリ上のSQLite（fake-database.ts）に差し替える。メソッドの形はD1に合わせてある。
 * テーブルの定義は migrations/ にある。
 *
 * 注意: SQLに値を埋め込まず、必ずプレースホルダ（?1 など）と bind で渡す。
 */
export type DatabaseValue = string | number | null

export interface DatabaseStatement {
  /** プレースホルダに値を当てはめた新しい文を返す */
  bind(...values: DatabaseValue[]): DatabaseStatement
  run(): Promise<unknown>
  /** 注意: Row は呼び出し側の申告で、実行時には確かめない。SELECT の列と揃えること */
  all<Row>(): Promise<{ results: Row[] }>
  first<Row>(): Promise<Row | null>
}

export interface Database {
  prepare(sql: string): DatabaseStatement
  /** 複数の文をひとつのトランザクションで実行する（途中で失敗したら全体を取り消す） */
  batch(statements: DatabaseStatement[]): Promise<unknown>
}
