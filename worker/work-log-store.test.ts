/**
 * 作業ログの読み書き（work-log-store.ts）のテスト
 *
 * migrations/ のSQLをそのまま適用したメモリ上のSQLite（fake-database.ts）で、次の3点を確かめる。
 * - 開発の出来事は配信中にだけ残り、同じ通知の再送（同じ X-GitHub-Delivery）では2行にならないこと
 * - 読み出しは、いま配信中の配信の出来事と章を新しい順に混ぜて並べ、上限で古いものを落とすこと
 * - 前の配信の出来事と章は、いまの配信のログに混ざらないこと
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createFakeDatabase } from './fake-database'
import { readWorkLog, recordDevEvent } from './work-log-store'

const STARTED_AT = '2026-10-03T12:00:00.000Z'
const startedAt = Date.parse(STARTED_AT)
const MINUTE = 60 * 1000
const iso = (milliseconds: number): string => new Date(milliseconds).toISOString()

let db: ReturnType<typeof createFakeDatabase>

/** 配信の区切りを1件作る。endedAt を省くと配信中になる */
const createStream = (id: string, started: string, endedAt: string | null = null): void => {
  db.sqlite
    .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, ?, ?, ?)')
    .run(id, started, endedAt, '作業配信', 'Software and Game Development')
}

const insertChapter = (sessionId: string, minutes: number, title: string): void => {
  db.sqlite
    .prepare('INSERT INTO stream_chapters (session_id, started_at, ended_at, title, summary) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, iso(startedAt + minutes * MINUTE), iso(startedAt + (minutes + 30) * MINUTE), title, '要約は作業ログに出さない')
}

beforeEach(() => {
  db = createFakeDatabase()
})

describe('recordDevEvent', () => {
  it('配信中に届いた出来事は残し、残した1行を返す', async () => {
    createStream('今日の配信', STARTED_AT)

    const recorded = await recordDevEvent(db, { id: 'github:delivery-1', kind: 'merge', text: '#213 作業ログを出す' }, startedAt + 10 * MINUTE)

    const merged = { id: 'github:delivery-1', kind: 'merge', at: iso(startedAt + 10 * MINUTE), text: '#213 作業ログを出す' }
    expect(recorded).toEqual(merged)
    expect(await readWorkLog(db, startedAt + 10 * MINUTE, 20)).toEqual([merged])
  })

  it('配信していないときに届いた出来事は残さず、null を返す', async () => {
    const recorded = await recordDevEvent(db, { id: 'github:delivery-1', kind: 'commit', text: '配信外のコミット' }, startedAt)

    expect(recorded).toBeNull()
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM dev_events').get()).toEqual({ count: 0 })
  })

  it('同じ通知が再送されても1行のままで、時刻は最初に届いたときのまま残して返す', async () => {
    createStream('今日の配信', STARTED_AT)

    await recordDevEvent(db, { id: 'github:delivery-1', kind: 'commit', text: 'テストを先に書く' }, startedAt + 10 * MINUTE)
    const redelivered = await recordDevEvent(db, { id: 'github:delivery-1', kind: 'commit', text: 'テストを先に書く' }, startedAt + 20 * MINUTE)

    // 再送で押し出し直す1行も、最初に届いた時刻のままにする（合成ページで行の位置がずれないように）
    expect(redelivered?.at).toBe(iso(startedAt + 10 * MINUTE))
    expect(await readWorkLog(db, startedAt + 30 * MINUTE, 20)).toEqual([
      { id: 'github:delivery-1', kind: 'commit', at: iso(startedAt + 10 * MINUTE), text: 'テストを先に書く' },
    ])
  })
})

describe('readWorkLog', () => {
  it('いまの配信の出来事と章を、新しい順に混ぜて並べる', async () => {
    createStream('今日の配信', STARTED_AT)
    insertChapter('今日の配信', 0, 'Webhookの署名を確かめる')
    await recordDevEvent(db, { id: 'github:commit-1', kind: 'commit', text: '署名の確認を足す' }, startedAt + 20 * MINUTE)
    insertChapter('今日の配信', 30, '作業ログの見た目を決める')
    await recordDevEvent(db, { id: 'github:merge-1', kind: 'merge', text: '#212 GitHub の Webhook を受ける' }, startedAt + 70 * MINUTE)

    expect((await readWorkLog(db, startedAt + 80 * MINUTE, 20)).map((entry) => `${entry.kind}:${entry.text}`)).toEqual([
      'merge:#212 GitHub の Webhook を受ける',
      'chapter:作業ログの見た目を決める',
      'commit:署名の確認を足す',
      'chapter:Webhookの署名を確かめる',
    ])
  })

  it('上限より多ければ、新しいものから上限の件数だけを返す（古いものを落とす）', async () => {
    createStream('今日の配信', STARTED_AT)
    for (const minutes of [1, 2, 3]) {
      await recordDevEvent(db, { id: `github:commit-${minutes}`, kind: 'commit', text: `${minutes}本目のコミット` }, startedAt + minutes * MINUTE)
    }

    expect((await readWorkLog(db, startedAt + 10 * MINUTE, 2)).map((entry) => entry.text)).toEqual(['3本目のコミット', '2本目のコミット'])
  })

  it('前の配信の出来事と章は混ぜない', async () => {
    const yesterday = startedAt - 24 * 60 * MINUTE
    createStream('昨日の配信', iso(yesterday), iso(yesterday + 120 * MINUTE))
    db.sqlite
      .prepare('INSERT INTO dev_events (id, session_id, kind, text, occurred_at) VALUES (?, ?, ?, ?, ?)')
      .run('github:old', '昨日の配信', 'commit', '昨日のコミット', iso(yesterday + 10 * MINUTE))
    db.sqlite
      .prepare('INSERT INTO stream_chapters (session_id, started_at, ended_at, title, summary) VALUES (?, ?, ?, ?, ?)')
      .run('昨日の配信', iso(yesterday), iso(yesterday + 30 * MINUTE), '昨日の章', '要約')
    createStream('今日の配信', STARTED_AT)
    await recordDevEvent(db, { id: 'github:today', kind: 'commit', text: '今日のコミット' }, startedAt + 10 * MINUTE)

    expect((await readWorkLog(db, startedAt + 20 * MINUTE, 20)).map((entry) => entry.text)).toEqual(['今日のコミット'])
  })

  it('配信していなければ空の一覧を返す（配信の前後にOBSを開いたままにするのが普通なので、失敗にしない）', async () => {
    createStream('終わった配信', STARTED_AT, iso(startedAt + 60 * MINUTE))
    insertChapter('終わった配信', 0, '終わった配信の章')

    expect(await readWorkLog(db, startedAt + 90 * MINUTE, 20)).toEqual([])
  })
})
