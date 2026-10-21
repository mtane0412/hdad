/**
 * 人形の組と増減の台帳の読み書き
 *
 * 人形の組（migrations/0045_dolls.sql の doll_sets）と、視聴者ごとの人形の増減の台帳（doll_ledger）を読み書きする（issue #418）。
 * 人形の増減を書くのはこのモジュールの changeDolls だけで、手での増減・トリガー・ゲームの正解はすべてここを通す。
 * 検証は worker/doll.ts が済ませたものだけを受け取り、ここでは確かめない。
 *
 * 注意: 増減するのは「いまの人形」の組だけ。いまの人形を選んでいなければ、黙って飛ばさずエラーにする（方針4）。
 * 注意: 減らすときに所持数が足りなければ、0 で止めずにエラーにする。確かめと書き込みは1つの文で行う
 *   （「数えてから書く」に分けると、並んだ2つの消費がどちらも確かめを通って所持数が負になるため）。
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。
 */
import type { Database } from './database'
import type { DollHolding, DollKind, DollOrigin, DollSet, DollSetInput } from './doll'

const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/** doll_sets の1行 */
interface DollSetRow {
  id: number
  normal_name: string
  normal_media_id: string
  super_name: string
  super_media_id: string
  current: number | null
  updated_at: string
}

const SET_COLUMNS = 'id, normal_name, normal_media_id, super_name, super_media_id, current, updated_at'

const toDollSet = (row: DollSetRow): DollSet => ({
  id: row.id,
  normal: { name: row.normal_name, mediaId: row.normal_media_id },
  super: { name: row.super_name, mediaId: row.super_media_id },
  current: row.current === 1,
  updatedAt: row.updated_at,
})

/** 所持数を読むときの1行（user_id・set_id ごとの合計） */
interface HoldingRow {
  user_id: string
  set_id: number
  normal: number
  super: number
}

const toHolding = (row: HoldingRow): DollHolding => ({ userId: row.user_id, setId: row.set_id, normal: row.normal, super: row.super })

/** user_id・set_id ごとに、種類別の所持数を合計する SELECT（WHERE は呼び出し側が足す） */
const HOLDING_SELECT = `SELECT user_id, set_id,
    COALESCE(SUM(CASE WHEN kind = 'normal' THEN delta END), 0) AS normal,
    COALESCE(SUM(CASE WHEN kind = 'super' THEN delta END), 0) AS super
  FROM doll_ledger`

/** 増減を受け付けなかった理由。no-current-set はいまの人形を選んでいない、not-enough は減らすだけの所持数が無い */
export type DollChangeErrorCode = 'no-current-set' | 'not-enough'

/** 人形の増減を受け付けなかった。呼び出し側は code で分岐する */
export class DollChangeError extends Error {
  override name = 'DollChangeError'

  constructor(
    readonly code: DollChangeErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** 人形の増減1件。何で増減したか（reason と、理由ごとに控える項目）は DollOrigin が持つ */
export type DollChange = DollOrigin & {
  /** Twitch のユーザー ID */
  readonly userId: string
  readonly kind: DollKind
  /** 増やすなら正、減らすなら負（0 は台帳の CHECK 制約が拒む） */
  readonly delta: number
  /** きっかけの ID。同じ ID の増減は2度記録しない（Twitch の通知の再送への備え） */
  readonly sourceId: string
}

/** 増減の結果。applied は記録した（増減したあとの、その人のいまの人形の所持数を添える）、duplicate は同じきっかけをもう記録していた */
export type DollChangeResult = { readonly status: 'applied'; readonly holding: DollHolding } | { readonly status: 'duplicate' }

/** 人形の組をすべて、追加した順に読む */
export const readDollSets = async (db: Database): Promise<DollSet[]> => {
  const { results } = await db.prepare(`SELECT ${SET_COLUMNS} FROM doll_sets ORDER BY id`).all<DollSetRow>()
  return results.map(toDollSet)
}

/**
 * 人形の組を1組追加する。追加した組は、まだいまの人形にしない（選ぶのは selectCurrentDollSet）。
 *
 * @returns 追加した組（振られた ID を含む）
 */
export const insertDollSet = async (db: Database, input: DollSetInput, now: number): Promise<DollSet> => {
  const row = await db
    .prepare(
      `INSERT INTO doll_sets (normal_name, normal_media_id, super_name, super_media_id, current, updated_at)
       VALUES (?1, ?2, ?3, ?4, NULL, ?5) RETURNING ${SET_COLUMNS}`,
    )
    .bind(input.normal.name, input.normal.mediaId, input.super.name, input.super.mediaId, toIso(now))
    .first<DollSetRow>()
  // RETURNING は追加した1行を必ず返す
  if (row === null) throw new Error('人形の組を追加しましたが、追加した行を読めませんでした')
  return toDollSet(row)
}

/**
 * 人形の組の名前と画像を書き換える。いまの人形かどうかは変えない。
 *
 * 台帳に記録のある組も書き換えられる（記録は組の ID を指すので、名前や画像を直しても所持数はそのまま残る）。
 *
 * @returns 書き換えた組。その ID の組が無ければ null
 */
export const updateDollSet = async (db: Database, id: number, input: DollSetInput, now: number): Promise<DollSet | null> => {
  const row = await db
    .prepare(
      `UPDATE doll_sets SET normal_name = ?2, normal_media_id = ?3, super_name = ?4, super_media_id = ?5, updated_at = ?6
       WHERE id = ?1 RETURNING ${SET_COLUMNS}`,
    )
    .bind(id, input.normal.name, input.normal.mediaId, input.super.name, input.super.mediaId, toIso(now))
    .first<DollSetRow>()
  return row === null ? null : toDollSet(row)
}

/**
 * 人形の組を消す。台帳に記録のある組は消さない（集めた記録が宙に浮くため）。
 *
 * 確かめと削除は1つの文で行う（確かめたあとに渡された人形の記録を、組ごと宙に浮かせないため）。
 *
 * @returns deleted は消した、in-use は台帳に記録があるので消さなかった、not-found はその ID の組が無い
 */
export const deleteDollSet = async (db: Database, id: number): Promise<'deleted' | 'in-use' | 'not-found'> => {
  const deleted = await db
    .prepare('DELETE FROM doll_sets WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM doll_ledger WHERE set_id = ?1) RETURNING id')
    .bind(id)
    .first<{ id: number }>()
  if (deleted !== null) return 'deleted'
  const exists = await db.prepare('SELECT id FROM doll_sets WHERE id = ?1').bind(id).first<{ id: number }>()
  return exists === null ? 'not-found' : 'in-use'
}

/**
 * いまの人形を選ぶ。null を渡すと、どの組もいまの人形にしない。
 *
 * 外してから付ける2つの文を1つのトランザクションで行う（current の UNIQUE は行ごとに確かめるので、1つの文で付け替えると
 * 途中で2行が 1 を持つ瞬間ができて失敗しうるため）。
 *
 * @returns 選べたなら true。その ID の組が無ければ false（いまの人形は変えない）
 */
export const selectCurrentDollSet = async (db: Database, id: number | null): Promise<boolean> => {
  const clear = db.prepare('UPDATE doll_sets SET current = NULL WHERE current = 1')
  if (id === null) {
    await clear.run()
    return true
  }
  const exists = await db.prepare('SELECT id FROM doll_sets WHERE id = ?1').bind(id).first<{ id: number }>()
  if (exists === null) return false
  await db.batch([clear, db.prepare('UPDATE doll_sets SET current = 1 WHERE id = ?1').bind(id)])
  return true
}

/**
 * いまの人形の増減を台帳に記録する。人形の増減を書くのはこの関数だけである。
 *
 * 記録した時点で配信中なら、その配信（stream_sessions の開いた行）の ID を控える。トリガーで渡したときは、どのトリガーの項目で
 * 渡したか（trigger_kind）も控える。
 *
 * @returns applied は記録した、duplicate は同じきっかけの ID をもう記録していた（再送なので何もしない）
 * @throws DollChangeError いまの人形を選んでいない（no-current-set）、減らすだけの所持数が無い（not-enough）場合。どちらも記録しない
 */
export const changeDolls = async (db: Database, change: DollChange, now: number): Promise<DollChangeResult> => {
  const inserted = await db
    .prepare(
      // いまの人形が無ければ SELECT が0行を返すので、INSERT も起きない。減らすときは、その人のいまの人形の同じ種類の所持数が
      // 減らす数に足りているときだけ行を返す。「WHERE ... ON CONFLICT」の形にしないと SQLite が ON を結合の条件と読むので、WHERE は外せない
      `INSERT INTO doll_ledger (user_id, set_id, kind, delta, reason, trigger_kind, source_id, session_id, created_at)
       SELECT ?1, s.id, ?2, ?3, ?4, ?7, ?5,
         (SELECT id FROM stream_sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1), ?6
       FROM doll_sets s
       WHERE s.current = 1
         AND (?3 > 0 OR (SELECT COALESCE(SUM(delta), 0) FROM doll_ledger WHERE user_id = ?1 AND set_id = s.id AND kind = ?2) + ?3 >= 0)
       ON CONFLICT (source_id) DO NOTHING
       RETURNING set_id`,
    )
    .bind(change.userId, change.kind, change.delta, change.reason, change.sourceId, toIso(now), change.reason === 'trigger' ? change.triggerKind : null)
    .first<{ set_id: number }>()

  if (inserted === null) {
    // 記録しなかった理由を見分ける（再送・いまの人形が無い・所持数が足りない）
    const duplicate = await db.prepare('SELECT id FROM doll_ledger WHERE source_id = ?1').bind(change.sourceId).first<{ id: number }>()
    if (duplicate !== null) return { status: 'duplicate' }
    const current = await db.prepare('SELECT id FROM doll_sets WHERE current = 1').first<{ id: number }>()
    if (current === null) throw new DollChangeError('no-current-set', 'いまの人形が選ばれていません。人形のページで選んでください')
    throw new DollChangeError('not-enough', `減らすだけの人形を持っていません（${-change.delta}つ減らそうとしました）`)
  }

  const holding = await db
    .prepare(`${HOLDING_SELECT} WHERE user_id = ?1 AND set_id = ?2 GROUP BY user_id, set_id`)
    .bind(change.userId, inserted.set_id)
    .first<HoldingRow>()
  // 記録した直後なので、その人のその組の行は必ずある
  if (holding === null) throw new Error('人形の増減を記録しましたが、所持数を読めませんでした')
  return { status: 'applied', holding: toHolding(holding) }
}

/**
 * 人形を持っている人の所持数を、組ごとにすべて読む。すべて減らして0になった組は出さない。
 *
 * 持っている人は視聴者の一部で、1人あたりの行も組の数だけなので、全件を一度に返す。
 */
export const readDollHoldings = async (db: Database): Promise<DollHolding[]> => {
  const { results } = await db
    .prepare(`${HOLDING_SELECT} GROUP BY user_id, set_id HAVING normal <> 0 OR super <> 0 ORDER BY user_id, set_id`)
    .all<HoldingRow>()
  return results.map(toHolding)
}

/** その人の台帳をすべて消す（視聴者の記録を消すとき。worker/viewer-store.ts の deleteViewer） */
export const deleteDollsOf = async (db: Database, userId: string): Promise<void> => {
  await db.prepare('DELETE FROM doll_ledger WHERE user_id = ?1').bind(userId).run()
}
