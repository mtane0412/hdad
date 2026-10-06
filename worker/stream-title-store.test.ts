/**
 * 配信タイトルの候補の読み書き（stream-title-store.ts）のテスト
 *
 * migrations/ のSQLをそのまま適用したメモリ上のSQLite（fake-database.ts）で、次に候補を作る章の選び方
 * （最後の章で、まだ候補が無いものだけ）と、その章の区間の画面の文字の読み出し、候補の保存と読み出しを確かめる。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createFakeDatabase } from './fake-database'
import { saveStreamChapter } from './stream-chapter-store'
import { listStreamTitleCandidates, readStreamTitleTarget, saveStreamTitleCandidate } from './stream-title-store'

const STARTED_AT = '2026-10-06T12:00:00.000Z'
const startedAt = Date.parse(STARTED_AT)
const MINUTE = 60 * 1000
const iso = (milliseconds: number): string => new Date(milliseconds).toISOString()
const SESSION_ID = '配信1'

let db: ReturnType<typeof createFakeDatabase>

/** 配信中の配信を1件作る */
const createStream = (id: string): void => {
  db.sqlite
    .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, ?, ?, ?)')
    .run(id, STARTED_AT, null, '【作業配信】HDADを育てる', 'Software and Game Development')
}

/** 配信の開始から minutes 分後に始まる30分の章を保存する */
const saveChapter = (minutes: number, title: string) =>
  saveStreamChapter(db, {
    sessionId: SESSION_ID,
    startedAt: iso(startedAt + minutes * MINUTE),
    endedAt: iso(startedAt + (minutes + 30) * MINUTE),
    title,
    summary: `${title}について進めた。`,
  })

/** 配信の開始から minutes 分後に積んだ画面の文字を1行入れる */
const insertScreenLine = (imageId: string, lineNo: number, minutes: number, text: string): void => {
  db.sqlite
    .prepare('INSERT INTO screen_lines (image_id, line_no, session_id, captured_at, text, sifted_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(imageId, lineNo, SESSION_ID, iso(startedAt + minutes * MINUTE), text, iso(startedAt + minutes * MINUTE))
}

beforeEach(() => {
  db = createFakeDatabase()
  createStream(SESSION_ID)
})

describe('readStreamTitleTarget', () => {
  it('まだ章が無ければ null を返す', async () => {
    expect(await readStreamTitleTarget(db, SESSION_ID)).toBeNull()
  })

  it('最後の章と、その区間に積んだ画面の文字を古い順に返す（前の章の区間の文字は含めない）', async () => {
    await saveChapter(0, '開発環境の準備')
    await saveChapter(30, 'タイトル候補の設計')
    insertScreenLine('前の章の画像', 0, 10, 'npm install')
    insertScreenLine('この章の画像', 1, 40, 'npm test')
    insertScreenLine('この章の画像', 0, 40, 'stream-title.ts')

    expect(await readStreamTitleTarget(db, SESSION_ID)).toEqual({
      chapter: {
        startedAt: iso(startedAt + 30 * MINUTE),
        endedAt: iso(startedAt + 60 * MINUTE),
        title: 'タイトル候補の設計',
        summary: 'タイトル候補の設計について進めた。',
      },
      screen: ['stream-title.ts', 'npm test'],
    })
  })

  it('最後の章にもう候補があれば null を返す（同じ章で作り直さない）', async () => {
    await saveChapter(0, '開発環境の準備')
    await saveStreamTitleCandidate(db, { sessionId: SESSION_ID, chapterStartedAt: STARTED_AT, candidate: '開発環境を整えています', publishable: 0.95 }, startedAt)

    expect(await readStreamTitleTarget(db, SESSION_ID)).toBeNull()
  })

  it('前の章で候補を作れなかったまま次の章ができたら、前の章には戻らず最後の章を返す', async () => {
    await saveChapter(0, '開発環境の準備')
    await saveChapter(30, 'タイトル候補の設計')

    expect((await readStreamTitleTarget(db, SESSION_ID))?.chapter.title).toBe('タイトル候補の設計')
  })
})

describe('listStreamTitleCandidates', () => {
  it('その配信の候補を、章の始まった順に返す', async () => {
    await saveChapter(0, '開発環境の準備')
    await saveChapter(30, 'タイトル候補の設計')
    const secondChapterAt = iso(startedAt + 30 * MINUTE)
    await saveStreamTitleCandidate(db, { sessionId: SESSION_ID, chapterStartedAt: secondChapterAt, candidate: '配信タイトルを機械に考えさせる準備中', publishable: 0.12 }, startedAt + 61 * MINUTE)
    await saveStreamTitleCandidate(db, { sessionId: SESSION_ID, chapterStartedAt: STARTED_AT, candidate: '開発環境を整えています', publishable: 0.95 }, startedAt + 31 * MINUTE)

    expect(await listStreamTitleCandidates(db, SESSION_ID)).toEqual([
      { chapterStartedAt: STARTED_AT, candidate: '開発環境を整えています', publishable: 0.95 },
      { chapterStartedAt: secondChapterAt, candidate: '配信タイトルを機械に考えさせる準備中', publishable: 0.12 },
    ])
  })

  it('候補が無ければ空を返す', async () => {
    expect(await listStreamTitleCandidates(db, SESSION_ID)).toEqual([])
  })
})
