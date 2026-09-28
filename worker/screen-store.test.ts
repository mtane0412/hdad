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
  abandonOcr,
  countOcrAttempt,
  deleteOldScreenCaptures,
  deleteOldScreenLines,
  listPendingOcr,
  listPendingSift,
  readCurrentScreenLines,
  readOwnScreenTexts,
  readRecentScreenLines,
  readScreenLinesSince,
  recordScreenCapture,
  saveScreenLines,
  saveScreenOcr,
} from './screen-store'
import { saveSideSuper } from './side-super-store'
import { recordStreamOffline, recordStreamOnline } from './stats-store'
import { recordStreamChatMessage } from './stream-chat-store'
import { recordTranscript } from './transcript-store'
import { recordViewerMessage } from './viewer-store'

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

describe('abandonOcr', () => {
  it('その1枚を、もう取りに行かない扱いにする', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await recordScreenCapture(db, 画像のID, 撮った時刻)

    await abandonOcr(db, 画像のID)
    expect(await listPendingOcr(db, 10)).toEqual([])
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

describe('listPendingSift', () => {
  it('読み取った文字があって、まだ篩に通していない行を、撮った順に返す', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await recordScreenCapture(db, 'あとで撮った1枚', 撮った時刻 + 60000)
    await recordScreenCapture(db, '先に撮った1枚', 撮った時刻)
    await saveScreenOcr(db, 'あとで撮った1枚', 'あとの画面の文字')
    await saveScreenOcr(db, '先に撮った1枚', '先の画面の文字')

    expect(await listPendingSift(db, 10)).toEqual([
      { imageId: '先に撮った1枚', sessionId: 'session-1', capturedAt: '2026-09-28T12:05:00.000Z', ocrText: '先の画面の文字' },
      { imageId: 'あとで撮った1枚', sessionId: 'session-1', capturedAt: '2026-09-28T12:06:00.000Z', ocrText: 'あとの画面の文字' },
    ])
  })

  it('読み取った文字をまだ取れていない行は返さない', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await recordScreenCapture(db, 画像のID, 撮った時刻)

    expect(await listPendingSift(db, 10)).toEqual([])
  })

  it('篩に通し終えた行は返さない（残った行が0行でも返さない）', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await recordScreenCapture(db, 画像のID, 撮った時刻)
    await saveScreenOcr(db, 画像のID, '画面に出ていた文字')
    await saveScreenLines(db, { imageId: 画像のID, sessionId: 'session-1', capturedAt: '2026-09-28T12:05:00.000Z' }, [], 撮った時刻)

    expect(await listPendingSift(db, 10)).toEqual([])
  })

  it('一度に返す件数を上限で抑える', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    for (const [番号, ずれ] of [1000, 2000, 3000].entries()) {
      await recordScreenCapture(db, `${番号}枚目`, 撮った時刻 + ずれ)
      await saveScreenOcr(db, `${番号}枚目`, '画面に出ていた文字')
    }

    expect(await listPendingSift(db, 2)).toHaveLength(2)
  })
})

describe('saveScreenLines', () => {
  const 撮った1枚 = { imageId: 画像のID, sessionId: 'session-1', capturedAt: '2026-09-28T12:05:00.000Z' }

  it('篩を通った行を、画面に現れた順に積む', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await recordScreenCapture(db, 画像のID, 撮った時刻)
    await saveScreenOcr(db, 画像のID, '岩手17歳女性殺害事件\n盛岡市のガソリンスタンド')

    await saveScreenLines(db, 撮った1枚, ['岩手17歳女性殺害事件', '盛岡市のガソリンスタンド'], 撮った時刻)
    expect(db.sqlite.prepare('SELECT line_no, text FROM screen_lines ORDER BY line_no').all()).toEqual([
      { line_no: 0, text: '岩手17歳女性殺害事件' },
      { line_no: 1, text: '盛岡市のガソリンスタンド' },
    ])
  })

  it('同じ1枚を二度通しても行は増えない', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await recordScreenCapture(db, 画像のID, 撮った時刻)
    await saveScreenOcr(db, 画像のID, '岩手17歳女性殺害事件')

    await saveScreenLines(db, 撮った1枚, ['岩手17歳女性殺害事件'], 撮った時刻)
    await saveScreenLines(db, 撮った1枚, ['岩手17歳女性殺害事件'], 撮った時刻)
    expect(db.sqlite.prepare('SELECT COUNT(*) AS 件数 FROM screen_lines').get()).toEqual({ 件数: 1 })
  })
})

describe('readRecentScreenLines', () => {
  it('その配信で既に渡した行を返す', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await recordScreenCapture(db, 画像のID, 撮った時刻)
    await saveScreenOcr(db, 画像のID, '岩手17歳女性殺害事件')
    await saveScreenLines(db, { imageId: 画像のID, sessionId: 'session-1', capturedAt: '2026-09-28T12:05:00.000Z' }, ['岩手17歳女性殺害事件'], 撮った時刻)

    expect(await readRecentScreenLines(db, 'session-1', 10)).toEqual(['岩手17歳女性殺害事件'])
  })

  it('別の配信の行は返さない', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await recordScreenCapture(db, 画像のID, 撮った時刻)
    await saveScreenOcr(db, 画像のID, '岩手17歳女性殺害事件')
    await saveScreenLines(db, { imageId: 画像のID, sessionId: 'session-1', capturedAt: '2026-09-28T12:05:00.000Z' }, ['岩手17歳女性殺害事件'], 撮った時刻)

    expect(await readRecentScreenLines(db, 'session-2', 10)).toEqual([])
  })

  it('件数の上限を超えたら、新しいほうを残す（いま映っている画面と照らすため）', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    for (const [番号, 行] of ['古い行', '新しい行'].entries()) {
      await recordScreenCapture(db, `${番号}枚目`, 撮った時刻 + 番号 * 1000)
      await saveScreenOcr(db, `${番号}枚目`, 行)
      await saveScreenLines(db, { imageId: `${番号}枚目`, sessionId: 'session-1', capturedAt: new Date(撮った時刻 + 番号 * 1000).toISOString() }, [行], 撮った時刻)
    }

    expect(await readRecentScreenLines(db, 'session-1', 1)).toEqual(['新しい行'])
  })
})

describe('readScreenLinesSince', () => {
  /** 1枚ぶんの行を積む。撮った時刻は画像IDの番号で1秒ずつずらす */
  const 積む = async (db: ReturnType<typeof createFakeDatabase>, 番号: number, lines: readonly string[]): Promise<void> => {
    const 時刻 = 撮った時刻 + 番号 * 1000
    await recordScreenCapture(db, `${番号}枚目`, 時刻)
    await saveScreenOcr(db, `${番号}枚目`, lines.join('\n'))
    await saveScreenLines(db, { imageId: `${番号}枚目`, sessionId: 'session-1', capturedAt: new Date(時刻).toISOString() }, lines, 時刻)
  }

  it('目印より後の行を、画面に現れた順に返す', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await 積む(db, 1, ['岩手17歳女性殺害事件'])
    await 積む(db, 2, ['盛岡市のガソリンスタンド', '2008年6月29日'])

    const 行 = await readScreenLinesSince(db, 'session-1', { at: '2026-09-28T12:05:01.000Z', imageId: '1枚目' }, 10)
    expect(行).toEqual([
      { text: '盛岡市のガソリンスタンド', at: '2026-09-28T12:05:02.000Z', imageId: '2枚目' },
      { text: '2008年6月29日', at: '2026-09-28T12:05:02.000Z', imageId: '2枚目' },
    ])
  })

  it('空文字の組を渡せば、その配信の行をすべて読める', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await 積む(db, 1, ['岩手17歳女性殺害事件'])

    const 行 = await readScreenLinesSince(db, 'session-1', { at: '', imageId: '' }, 10)
    expect(行.map((line) => line.text)).toEqual(['岩手17歳女性殺害事件'])
  })

  it('別の配信の行は読まない', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await 積む(db, 1, ['岩手17歳女性殺害事件'])

    expect(await readScreenLinesSince(db, 'session-2', { at: '', imageId: '' }, 10)).toEqual([])
  })

  it('件数の上限を超えたら、古いほうを残す（続きは次の収集で読むため）', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await 積む(db, 1, ['古い行'])
    await 積む(db, 2, ['新しい行'])

    const 行 = await readScreenLinesSince(db, 'session-1', { at: '', imageId: '' }, 1)
    expect(行.map((line) => line.text)).toEqual(['古い行'])
  })
})

describe('readCurrentScreenLines', () => {
  it('直近に現れた行を、画面に現れた順（古い順）に、撮った時刻を添えて返す', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await recordScreenCapture(db, 画像のID, 撮った時刻)
    await saveScreenOcr(db, 画像のID, '岩手17歳女性殺害事件')
    await saveScreenLines(db, { imageId: 画像のID, sessionId: 'session-1', capturedAt: '2026-09-28T12:05:00.000Z' }, ['岩手17歳女性殺害事件'], 撮った時刻)

    expect(await readCurrentScreenLines(db, 'session-1', 10)).toEqual([{ text: '岩手17歳女性殺害事件', at: '2026-09-28T12:05:00.000Z' }])
  })

  it('件数の上限を超えたら新しいほうを残し、返すときは古い順に直す', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    for (const [番号, 行] of ['古い行', '中ほどの行', '新しい行'].entries()) {
      await recordScreenCapture(db, `${番号}枚目`, 撮った時刻 + 番号 * 1000)
      await saveScreenOcr(db, `${番号}枚目`, 行)
      await saveScreenLines(db, { imageId: `${番号}枚目`, sessionId: 'session-1', capturedAt: new Date(撮った時刻 + 番号 * 1000).toISOString() }, [行], 撮った時刻)
    }

    expect((await readCurrentScreenLines(db, 'session-1', 2)).map((line) => line.text)).toEqual(['中ほどの行', '新しい行'])
  })

  it('別の配信の行は返さない', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await recordScreenCapture(db, 画像のID, 撮った時刻)
    await saveScreenOcr(db, 画像のID, '岩手17歳女性殺害事件')
    await saveScreenLines(db, { imageId: 画像のID, sessionId: 'session-1', capturedAt: '2026-09-28T12:05:00.000Z' }, ['岩手17歳女性殺害事件'], 撮った時刻)

    expect(await readCurrentScreenLines(db, 'session-2', 10)).toEqual([])
  })
})

describe('readOwnScreenTexts', () => {
  it('サイドスーパー・視聴者の発言と表示名・配信者の発話を返す', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await saveSideSuper(db, 'session-1', ['いま話していること', '見出しの下の1行'], 撮った時刻)
    await recordViewerMessage(db, { userId: 'u1', login: 'tanenobu', displayName: 'たねのぶ', badges: [], messageId: 'm1' }, 撮った時刻)
    await recordStreamChatMessage(db, { messageId: 'm1', userId: 'u1', text: 'それは面白いですね' }, 撮った時刻)
    await recordTranscript(db, { messageId: 't1', text: '岩手の事件について話します' }, 撮った時刻)

    expect((await readOwnScreenTexts(db, 'session-1', 10)).sort()).toEqual(
      ['いま話していること', '見出しの下の1行', 'たねのぶ', 'それは面白いですね', '岩手の事件について話します'].sort(),
    )
  })

  it('別の配信のぶんは返さない', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await saveSideSuper(db, 'session-1', ['いま話していること', '見出しの下の1行'], 撮った時刻)
    await recordTranscript(db, { messageId: 't1', text: '岩手の事件について話します' }, 撮った時刻)

    expect(await readOwnScreenTexts(db, 'session-2', 10)).toEqual([])
  })
})

describe('deleteOldScreenLines', () => {
  it('終わった配信の、期限より古い行を消す', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await recordScreenCapture(db, 画像のID, 撮った時刻)
    await saveScreenOcr(db, 画像のID, '岩手17歳女性殺害事件')
    await saveScreenLines(db, { imageId: 画像のID, sessionId: 'session-1', capturedAt: '2026-09-28T12:05:00.000Z' }, ['岩手17歳女性殺害事件'], 撮った時刻)
    await recordStreamOffline(db, 撮った時刻 + 60000)

    await deleteOldScreenLines(db, 撮った時刻 + 120000)
    expect(db.sqlite.prepare('SELECT COUNT(*) AS 件数 FROM screen_lines').get()).toEqual({ 件数: 0 })
  })

  it('配信中の区切りのぶんは、期限より古くても消さない', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'session-1', startedAt: 配信の開始 })
    await recordScreenCapture(db, 画像のID, 撮った時刻)
    await saveScreenOcr(db, 画像のID, '岩手17歳女性殺害事件')
    await saveScreenLines(db, { imageId: 画像のID, sessionId: 'session-1', capturedAt: '2026-09-28T12:05:00.000Z' }, ['岩手17歳女性殺害事件'], 撮った時刻)

    await deleteOldScreenLines(db, 撮った時刻 + 120000)
    expect(db.sqlite.prepare('SELECT COUNT(*) AS 件数 FROM screen_lines').get()).toEqual({ 件数: 1 })
  })
})
