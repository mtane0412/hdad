/**
 * 配信の章立ての読み書き（stream-chapter-store.ts）のテスト
 *
 * migrations/ のSQLをそのまま適用したメモリ上のSQLite（fake-database.ts）で、章を作る対象の選び方・
 * 区間の材料の読み出し・章の保存と目印の進め方を確かめる。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createFakeDatabase } from './fake-database'
import { listChapterTargets, listStreamChapters, readChapterLines, saveStreamChapter, skipChapterWindow } from './stream-chapter-store'

const STARTED_AT = '2026-09-30T12:00:00.000Z'
const startedAt = Date.parse(STARTED_AT)
const MINUTE = 60 * 1000
const iso = (milliseconds: number): string => new Date(milliseconds).toISOString()

let db: ReturnType<typeof createFakeDatabase>

/** 配信の区切りを1件作る。endedAt を省くと配信中になる */
const createStream = (id: string, endedAt: string | null = null): void => {
  db.sqlite
    .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, ?, ?, ?)')
    .run(id, STARTED_AT, endedAt, '新しいマイクで雑談', 'Just Chatting')
}

const insertTranscript = (messageId: string, sessionId: string, minutes: number, text: string): void => {
  db.sqlite
    .prepare('INSERT INTO transcripts (message_id, session_id, spoken_at, text) VALUES (?, ?, ?, ?)')
    .run(messageId, sessionId, iso(startedAt + minutes * MINUTE), text)
}

const insertChat = (messageId: string, sessionId: string, minutes: number, text: string): void => {
  db.sqlite
    .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
    .run(messageId, sessionId, '100', iso(startedAt + minutes * MINUTE), text)
}

const insertScreenLine = (imageId: string, lineNo: number, sessionId: string, minutes: number, text: string): void => {
  db.sqlite
    .prepare('INSERT INTO screen_lines (image_id, line_no, session_id, captured_at, text, sifted_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(imageId, lineNo, sessionId, iso(startedAt + minutes * MINUTE), text, iso(startedAt + minutes * MINUTE))
}

beforeEach(() => {
  db = createFakeDatabase()
})

describe('listChapterTargets', () => {
  it('配信中の配信と、終わりまで章にし終えていない終わった配信を、始まった順に返す', async () => {
    createStream('配信中')
    createStream('作りかけ', iso(startedAt + 60 * MINUTE))
    db.sqlite.prepare('UPDATE stream_sessions SET chaptered_until = ? WHERE id = ?').run(iso(startedAt + 30 * MINUTE), '作りかけ')
    createStream('作り終えた', iso(startedAt + 60 * MINUTE))
    db.sqlite.prepare('UPDATE stream_sessions SET chaptered_until = ended_at WHERE id = ?').run('作り終えた')

    expect(await listChapterTargets(db)).toEqual([
      { id: '作りかけ', startedAt: STARTED_AT, endedAt: iso(startedAt + 60 * MINUTE), chapteredUntil: iso(startedAt + 30 * MINUTE), title: '新しいマイクで雑談', categoryName: 'Just Chatting' },
      { id: '配信中', startedAt: STARTED_AT, endedAt: null, chapteredUntil: null, title: '新しいマイクで雑談', categoryName: 'Just Chatting' },
    ])
  })
})

describe('readChapterLines', () => {
  it('区間の中の発話・発言・画面の文字だけを、古い順に読む（始まりは含み、終わりは含まない）', async () => {
    createStream('配信1')
    insertTranscript('発話0', '配信1', 0, '配信を始めます')
    insertTranscript('発話2', '配信1', 30, '次の区間の発話')
    insertTranscript('発話1', '配信1', 10, 'マイクを買い替えました')
    insertChat('発言1', '配信1', 11, 'いい音！')
    insertChat('発言2', '配信1', 31, '次の区間の発言')
    insertScreenLine('画像1', 0, '配信1', 12, 'USBマイク 比較')
    insertTranscript('ほかの配信', '配信2', 5, 'ほかの配信の発話')

    const lines = await readChapterLines(db, '配信1', { from: STARTED_AT, to: iso(startedAt + 30 * MINUTE) }, { transcripts: 10, chats: 10, screen: 10 })

    expect(lines).toEqual({
      transcripts: [
        { text: '配信を始めます', at: STARTED_AT },
        { text: 'マイクを買い替えました', at: iso(startedAt + 10 * MINUTE) },
      ],
      chats: [{ text: 'いい音！', at: iso(startedAt + 11 * MINUTE) }],
      screen: [{ text: 'USBマイク 比較', at: iso(startedAt + 12 * MINUTE) }],
    })
  })

  it('上限より1件多く読む（区間を縮めるかどうかを呼び出し側が見分けられるようにするため）', async () => {
    createStream('配信1')
    insertTranscript('発話1', '配信1', 1, '1つめ')
    insertTranscript('発話2', '配信1', 2, '2つめ')
    insertTranscript('発話3', '配信1', 3, '3つめ')

    const lines = await readChapterLines(db, '配信1', { from: STARTED_AT, to: iso(startedAt + 30 * MINUTE) }, { transcripts: 1, chats: 1, screen: 1 })

    expect(lines.transcripts.map((line) => line.text)).toEqual(['1つめ', '2つめ'])
  })
})

describe('saveStreamChapter', () => {
  it('章を保存し、どこまでを章にしたかを章の終わりまで進める', async () => {
    createStream('配信1')

    await saveStreamChapter(db, {
      sessionId: '配信1',
      startedAt: STARTED_AT,
      endedAt: iso(startedAt + 30 * MINUTE),
      title: '新しいマイクのお披露目',
      summary: '配信者が買い替えたマイクの音を聞かせた。',
    })

    expect(await listStreamChapters(db, '配信1')).toEqual([
      { startedAt: STARTED_AT, endedAt: iso(startedAt + 30 * MINUTE), title: '新しいマイクのお披露目', summary: '配信者が買い替えたマイクの音を聞かせた。' },
    ])
    expect(db.sqlite.prepare('SELECT chaptered_until FROM stream_sessions WHERE id = ?').get('配信1')).toEqual({ chaptered_until: iso(startedAt + 30 * MINUTE) })
  })
})

describe('skipChapterWindow', () => {
  it('章を作らずに、どこまでを章にしたかだけを進める（発話の無い区間のため）', async () => {
    createStream('配信1')

    await skipChapterWindow(db, '配信1', iso(startedAt + 30 * MINUTE))

    expect(await listStreamChapters(db, '配信1')).toEqual([])
    expect(db.sqlite.prepare('SELECT chaptered_until FROM stream_sessions WHERE id = ?').get('配信1')).toEqual({ chaptered_until: iso(startedAt + 30 * MINUTE) })
  })
})

describe('listStreamChapters', () => {
  it('その配信の章を、区間の始まった順に返す', async () => {
    createStream('配信1')
    await saveStreamChapter(db, { sessionId: '配信1', startedAt: iso(startedAt + 30 * MINUTE), endedAt: iso(startedAt + 60 * MINUTE), title: 'ゲームの攻略', summary: 'ステージ3に挑んだ。' })
    await saveStreamChapter(db, { sessionId: '配信1', startedAt: STARTED_AT, endedAt: iso(startedAt + 30 * MINUTE), title: '新しいマイクのお披露目', summary: 'マイクの音を聞かせた。' })

    expect((await listStreamChapters(db, '配信1')).map((chapter) => chapter.title)).toEqual(['新しいマイクのお披露目', 'ゲームの攻略'])
  })
})
