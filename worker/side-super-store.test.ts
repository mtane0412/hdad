/**
 * サイドスーパーの読み書き（side-super-store.ts）のテスト
 *
 * 配信の区切りごとに1行だけ持つこと、配信中の区切りのぶんだけを読み出すことを確かめる。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createFakeDatabase } from './fake-database'
import { readCurrentSideSuper, readSideSuper, saveSideSuper } from './side-super-store'

const 作成時刻 = Date.parse('2026-09-23T20:10:00.000Z')

let db: ReturnType<typeof createFakeDatabase>

/** 配信中の区切りを1件作る */
const 配信を始める = (id: string, startedAt = Date.parse('2026-09-23T20:00:00.000Z')): void => {
  db.sqlite
    .prepare('INSERT INTO stream_sessions (id, started_at, title, category_name) VALUES (?, ?, ?, ?)')
    .run(id, new Date(startedAt).toISOString(), '初見プレイ2日目', 'Elden Ring')
}

/** 配信中の区切りをすべて閉じる */
const 配信を終える = (endedAt: number): void => {
  db.sqlite.prepare('UPDATE stream_sessions SET ended_at = ? WHERE ended_at IS NULL').run(new Date(endedAt).toISOString())
}

beforeEach(() => {
  db = createFakeDatabase()
})

describe('readSideSuper', () => {
  it('まだ作っていない配信では null を返す', async () => {
    expect(await readSideSuper(db, '配信1')).toBeNull()
  })

  it('配信が終わっていても、その配信のサイドスーパーは読める（作り直しの判定に使うため）', async () => {
    配信を始める('配信1')
    await saveSideSuper(db, '配信1', ['2つめの街に到着'], 作成時刻)
    配信を終える(作成時刻 + 60000)

    expect(await readSideSuper(db, '配信1')).toEqual({ lines: ['2つめの街に到着'], updatedAt: '2026-09-23T20:10:00.000Z' })
  })
})

describe('readCurrentSideSuper', () => {
  it('配信していなければ null を返す', async () => {
    expect(await readCurrentSideSuper(db, 作成時刻)).toBeNull()
  })

  it('配信中でもまだ作っていなければ null を返す', async () => {
    配信を始める('配信1')

    expect(await readCurrentSideSuper(db, 作成時刻)).toBeNull()
  })

  it('いま進んでいる配信のサイドスーパーを、作った日時とともに返す', async () => {
    配信を始める('配信1')
    await saveSideSuper(db, '配信1', ['2つめの街に到着', 'ボス戦へ向けて装備集め'], 作成時刻)

    expect(await readCurrentSideSuper(db, 作成時刻)).toEqual({
      lines: ['2つめの街に到着', 'ボス戦へ向けて装備集め'],
      updatedAt: '2026-09-23T20:10:00.000Z',
    })
  })

  it('1行だけのサイドスーパーは1行のまま返す', async () => {
    配信を始める('配信1')
    await saveSideSuper(db, '配信1', ['雑談しています'], 作成時刻)

    expect(await readCurrentSideSuper(db, 作成時刻)).toEqual({ lines: ['雑談しています'], updatedAt: '2026-09-23T20:10:00.000Z' })
  })

  it('作り直すと上書きされ、行は1件のままになる', async () => {
    配信を始める('配信1')
    await saveSideSuper(db, '配信1', ['2つめの街に到着'], 作成時刻)
    await saveSideSuper(db, '配信1', ['ボスに挑戦中'], 作成時刻 + 300000)

    expect(await readCurrentSideSuper(db, 作成時刻 + 300000)).toEqual({ lines: ['ボスに挑戦中'], updatedAt: '2026-09-23T20:15:00.000Z' })
  })

  it('配信が終わっていれば、その配信のサイドスーパーは返さない', async () => {
    配信を始める('配信1')
    await saveSideSuper(db, '配信1', ['2つめの街に到着'], 作成時刻)
    配信を終える(作成時刻 + 60000)

    expect(await readCurrentSideSuper(db, 作成時刻 + 120000)).toBeNull()
  })

  it('前の配信のサイドスーパーは次の配信に持ち越さない', async () => {
    配信を始める('配信1')
    await saveSideSuper(db, '配信1', ['2つめの街に到着'], 作成時刻)
    配信を終える(作成時刻 + 60000)
    配信を始める('配信2', 作成時刻 + 120000)

    expect(await readCurrentSideSuper(db, 作成時刻 + 180000)).toBeNull()
  })
})
