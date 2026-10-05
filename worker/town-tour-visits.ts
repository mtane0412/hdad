/**
 * 市町村紹介で紹介した市町村の記録（全国制覇マップ。issue #252）
 *
 * 合成ページが紹介を流しきったら記録し（recordTownTourVisit）、市町村を引くときに紹介済みのコードを読む（listTownTourVisits）。
 * 読んだコードは、引くときに除くのと、合成ページで制覇マップを塗るのに使う。
 * テーブルの定義は migrations/0027_town_tour_visits.sql にある。日時は UTC の ISO 8601 の文字列で持つ。
 *
 * 注意: 1市町村1行で、同じ市町村をもう一度記録しても最初の記録を残す（上書きしない）。
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。
 */
import type { Database } from './database'

/** 紹介を記録するきっかけ。試し再生は記録しないので持たない */
export type TownTourVisitOccasion = 'raid' | 'keyword'

/** 記録する1件 */
export interface TownTourVisit {
  /** 全国地方公共団体コードの5桁 */
  readonly code: string
  readonly occasion: TownTourVisitOccasion
  /** 冒頭で名前を出した相手（レイド元・キーワードを書いた人）の表示名 */
  readonly userName: string
}

/** 紹介した市町村を記録する。もう記録してあれば何もしない（最初に紹介したときの記録を残す） */
export const recordTownTourVisit = async (db: Database, visit: TownTourVisit, now: number): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO town_tour_visits (code, visited_at, occasion, user_name) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (code) DO NOTHING`,
    )
    .bind(visit.code, new Date(now).toISOString(), visit.occasion, visit.userName)
    .run()
}

/** これまでに紹介した市町村のコード（並びは決めない） */
export const listTownTourVisits = async (db: Database): Promise<string[]> => {
  const { results } = await db.prepare('SELECT code FROM town_tour_visits').all<{ code: string }>()
  return results.map(({ code }) => code)
}
