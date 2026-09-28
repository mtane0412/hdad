/**
 * 配信画面の取り込みの記録（worker/screen-store.ts）のテスト
 *
 * メモリ上のD1（fake-database）で確かめる。特に重要なのは次の3点である。
 * - 配信中でなければ1行も書かないこと（配信前の準備画面や配信後のデスクトップを貯めないため）
 * - 同じ画像IDで二度呼ばれても行が増えず、どちらにも「記録した」と答えること
 * - 終わった配信の古い行を消せること（画面の取り込みは配信中だけ持つものであるため）
 * - OCRをまだ取れていない行だけを、撮った順に、件数を抑えて引けること
 * - 試みた回数が上限に達した行を引かなくなること（生成されない画像をいつまでも取りに行かないため）
 */
import { describe, expect, it } from 'vitest'
import { createFakeDatabase } from './fake-database'
import {
  OCR_MAX_ATTEMPTS,
  countOcrAttempt,
  deleteOldScreenCaptures,
  listPendingOcr,
  recordScreenCapture,
  saveScreenOcr,
} from './screen-store'
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

describe('listPendingOcr', () => {
  it('OCRをまだ取れていない行を、撮った順に返す', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await recordScreenCapture(db, 'あとで撮った1枚', 撮った時刻 + 60000)
    await recordScreenCapture(db, '先に撮った1枚', 撮った時刻)

    expect(await listPendingOcr(db, 10)).toEqual([
      { imageId: '先に撮った1枚', capturedAt: '2026-09-28T12:05:00.000Z' },
      { imageId: 'あとで撮った1枚', capturedAt: '2026-09-28T12:06:00.000Z' },
    ])
  })

  it('OCRを取れた行は返さない', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await recordScreenCapture(db, 画像のID, 撮った時刻)
    await saveScreenOcr(db, 画像のID, '画面に出ていた文字')

    expect(await listPendingOcr(db, 10)).toEqual([])
  })

  it('試みた回数が上限に達した行は返さない（いつまでも取りに行かないため）', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await recordScreenCapture(db, 画像のID, 撮った時刻)
    for (let 回 = 0; 回 < OCR_MAX_ATTEMPTS; 回 += 1) await countOcrAttempt(db, 画像のID)

    expect(await listPendingOcr(db, 10)).toEqual([])
  })

  it('上限に達するまでは返し続ける', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await recordScreenCapture(db, 画像のID, 撮った時刻)
    await countOcrAttempt(db, 画像のID)

    expect(await listPendingOcr(db, 10)).toHaveLength(1)
  })

  it('一度に返す件数を上限で抑える（1回の収集で外への呼び出しが増えすぎないため）', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await recordScreenCapture(db, '1枚目', 撮った時刻)
    await recordScreenCapture(db, '2枚目', 撮った時刻 + 1000)
    await recordScreenCapture(db, '3枚目', 撮った時刻 + 2000)

    expect(await listPendingOcr(db, 2)).toHaveLength(2)
  })
})

describe('saveScreenOcr', () => {
  it('読み取った文字を記録する', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await recordScreenCapture(db, 画像のID, 撮った時刻)

    await saveScreenOcr(db, 画像のID, '岩手17歳女性殺害事件')
    expect(db.sqlite.prepare('SELECT ocr_text FROM screen_captures').get()).toEqual({ ocr_text: '岩手17歳女性殺害事件' })
  })
})
