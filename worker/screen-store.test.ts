/**
 * 配信画面の取り込みの記録（worker/screen-store.ts）のテスト
 *
 * メモリ上のD1（fake-database）で確かめる。特に重要なのは次の3点である。
 * - 配信中でなければ1行も書かないこと（配信前の準備画面や配信後のデスクトップを貯めないため）
 * - 同じ画像IDで二度呼ばれても行が増えず、どちらにも「記録した」と答えること
 * - 終わった配信の古い行を消せること（画面の取り込みは配信中だけ持つものであるため）
 */
import { describe, expect, it } from 'vitest'
import { createFakeDatabase } from './fake-database'
import { deleteOldScreenCaptures, recordScreenCapture } from './screen-store'
import { recordStreamOffline, recordStreamOnline } from './stats-store'

const 配信の開始 = Date.parse('2026-09-28T12:00:00Z')
const 撮った時刻 = Date.parse('2026-09-28T12:05:00Z')
const 画像のID = 'abcdef0123456789abcdef0123456789'

describe('recordScreenCapture', () => {
  it('配信中なら記録する', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })

    expect(await recordScreenCapture(db, 画像のID, 撮った時刻)).toBe(true)
    const 行 = db.sqlite.prepare('SELECT image_id, session_id, captured_at FROM screen_captures').all()
    expect(行).toEqual([{ image_id: 画像のID, session_id: 'session-1', captured_at: '2026-09-28T12:05:00.000Z' }])
  })

  it('配信していなければ1行も書かず、書かなかったことを知らせる', async () => {
    const db = createFakeDatabase()

    expect(await recordScreenCapture(db, 画像のID, 撮った時刻)).toBe(false)
    expect(db.sqlite.prepare('SELECT COUNT(*) AS 件数 FROM screen_captures').get()).toEqual({ 件数: 0 })
  })

  it('同じ画像IDで二度呼ばれても行は増えず、どちらにも記録したと答える', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })

    expect(await recordScreenCapture(db, 画像のID, 撮った時刻)).toBe(true)
    expect(await recordScreenCapture(db, 画像のID, 撮った時刻 + 60000)).toBe(true)
    const 行 = db.sqlite.prepare('SELECT captured_at FROM screen_captures').all()
    // 最初に撮った時刻のまま残す（同じ画面を撮り続けたときに、撮った時刻が動き続けないようにする）
    expect(行).toEqual([{ captured_at: '2026-09-28T12:05:00.000Z' }])
  })
})

describe('deleteOldScreenCaptures', () => {
  it('終わった配信の、期限より古い行を消す', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await recordScreenCapture(db, 画像のID, 撮った時刻)
    await recordStreamOffline(db, 撮った時刻 + 60000)

    await deleteOldScreenCaptures(db, 撮った時刻 + 120000)
    expect(db.sqlite.prepare('SELECT COUNT(*) AS 件数 FROM screen_captures').get()).toEqual({ 件数: 0 })
  })

  it('配信中の区切りのぶんは、期限より古くても消さない（耐久配信の序盤を失わないため）', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await recordScreenCapture(db, 画像のID, 撮った時刻)

    await deleteOldScreenCaptures(db, 撮った時刻 + 120000)
    expect(db.sqlite.prepare('SELECT COUNT(*) AS 件数 FROM screen_captures').get()).toEqual({ 件数: 1 })
  })
})
