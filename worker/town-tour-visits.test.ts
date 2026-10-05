/**
 * 紹介した市町村の記録（town-tour-visits.ts）のテスト
 *
 * メモリ上のSQLite（fake-database.ts）に migrations/ を適用して確かめる。特に重要なのは次の2点。
 * - 1市町村につき1行で、最初に紹介したときの記録を残す（同じ市町村を2回記録しても行は増えず、上書きもしない）
 * - 合成ページを2つ開いていて同じ紹介が2回届いても、記録は1行のまま
 */
import { describe, expect, it } from 'vitest'
import { createFakeDatabase } from './fake-database'
import { listTownTourVisits, recordTownTourVisit } from './town-tour-visits'

const now = Date.UTC(2026, 9, 5, 12, 0, 0)

describe('recordTownTourVisit', () => {
  it('紹介した市町村を、紹介した日時・きっかけ・相手の名前と一緒に記録する', async () => {
    const db = createFakeDatabase()

    await recordTownTourVisit(db, { code: '01303', occasion: 'raid', userName: '山田花子' }, now)

    expect(db.sqlite.prepare('SELECT code, visited_at, occasion, user_name FROM town_tour_visits').all()).toEqual([
      { code: '01303', visited_at: '2026-10-05T12:00:00.000Z', occasion: 'raid', user_name: '山田花子' },
    ])
  })

  it('同じ市町村をもう一度記録しても、最初に紹介したときの記録を残す（1市町村1行）', async () => {
    const db = createFakeDatabase()
    await recordTownTourVisit(db, { code: '01303', occasion: 'raid', userName: '山田花子' }, now)

    await recordTownTourVisit(db, { code: '01303', occasion: 'keyword', userName: '田中太郎' }, now + 60_000)

    expect(db.sqlite.prepare('SELECT code, occasion, user_name FROM town_tour_visits').all()).toEqual([
      { code: '01303', occasion: 'raid', user_name: '山田花子' },
    ])
  })
})

describe('listTownTourVisits', () => {
  it('紹介した市町村のコードを返す', async () => {
    const db = createFakeDatabase()
    await recordTownTourVisit(db, { code: '01303', occasion: 'raid', userName: '山田花子' }, now)
    await recordTownTourVisit(db, { code: '13101', occasion: 'keyword', userName: '田中太郎' }, now + 60_000)

    expect([...(await listTownTourVisits(db))].sort()).toEqual(['01303', '13101'])
  })

  it('まだ1つも紹介していなければ空を返す', async () => {
    expect(await listTownTourVisits(createFakeDatabase())).toEqual([])
  })
})
