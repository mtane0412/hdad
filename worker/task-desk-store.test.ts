/**
 * 作業机の読み書き（task-desk-store.ts）のテスト
 *
 * migrations/ のSQLをそのまま適用したメモリ上のSQLite（fake-database.ts）で、次の点を確かめる。
 * - 宣言は配信中にだけ残り、1人1行で、打ち直すと差し替わること（同じ発言の再送では時刻も完了も変わらないこと）
 * - 完了は配信中の未完了の宣言にだけ付き、配信していない・宣言が無い・もう完了している、を見分けて返すこと
 * - 読み出しは、未完了を宣言の新しい順、そのあと完了を完了の新しい順に並べ、上限で切ること
 * - モデレーションで消された発言・人・チャット全体に当たる宣言を、いまの配信から消すこと
 * - 前の配信の宣言は、いまの配信の作業机に混ざらないこと
 * - 作業した時間の合計は、打ち直す前の宣言の時間も含み、配信ごとに分かれること（issue #209）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createFakeDatabase } from './fake-database'
import { completeTask, declareTask, readCurrentWorkTime, readSessionWorkTime, readTaskDesk, readTaskDeskSnapshot, removeModeratedTasks } from './task-desk-store'

const STARTED_AT = '2026-10-03T12:00:00.000Z'
const startedAt = Date.parse(STARTED_AT)
const MINUTE = 60 * 1000
const iso = (milliseconds: number): string => new Date(milliseconds).toISOString()
/** 配信が始まってから minutes 分後の時刻 */
const at = (minutes: number): number => startedAt + minutes * MINUTE

let db: ReturnType<typeof createFakeDatabase>

/** 配信中の区切りを1件作る */
const createStream = (id: string, started: string): void => {
  db.sqlite
    .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
    .run(id, started, '作業配信', 'Software and Game Development')
}

/** 呼ぶたびに別の発言として !done を作る（同じ発言の再送と見分けるため、発言のIDを毎回変える） */
let doneCount = 0
const doneBy = (userId: string, messageId = `done-message-${(doneCount += 1)}`) => ({ userId, messageId })

/** 視聴者の宣言（userId と名前と作業）を、発言のIDを添えて作る */
const declaration = (userId: string, name: string, task: string, messageId = `message-${userId}`) => ({ userId, name, task, messageId })

/** 前の配信の最中に「たなか」が宣言し、その配信を終える。宣言は配信中にしか残らないので、終える前に宣言する */
const declareInPreviousStream = async (): Promise<void> => {
  createStream('前の配信', '2026-10-02T12:00:00.000Z')
  expect(await declareTask(db, declaration('11111', 'たなか', '前の配信の作業'), Date.parse('2026-10-02T13:00:00.000Z'))).toBe(true)
  db.sqlite.prepare('UPDATE stream_sessions SET ended_at = ? WHERE id = ?').run('2026-10-02T15:00:00.000Z', '前の配信')
}

beforeEach(() => {
  db = createFakeDatabase()
})

describe('declareTask', () => {
  it('配信中なら宣言を残し、作業机に未完了で並ぶ', async () => {
    createStream('今日の配信', STARTED_AT)

    expect(await declareTask(db, declaration('11111', 'たなか', '英単語を50個覚える'), at(5))).toBe(true)

    expect(await readTaskDesk(db, at(5), 12)).toEqual([
      { userId: '11111', name: 'たなか', task: '英単語を50個覚える', declaredAt: iso(at(5)), doneAt: null },
    ])
  })

  it('配信していなければ残さず false を返す', async () => {
    expect(await declareTask(db, declaration('11111', 'たなか', '英単語を50個覚える'), at(5))).toBe(false)
  })

  it('同じ人が打ち直すと、作業と宣言の時刻を差し替え、完了を外す（1人1行）', async () => {
    createStream('今日の配信', STARTED_AT)
    await declareTask(db, declaration('11111', 'たなか', '英単語を50個覚える', 'message-1'), at(5))
    await completeTask(db, doneBy('11111'), at(30))

    await declareTask(db, declaration('11111', 'たなか', '数学の問題集を3ページ', 'message-2'), at(31))

    expect(await readTaskDesk(db, at(31), 12)).toEqual([
      { userId: '11111', name: 'たなか', task: '数学の問題集を3ページ', declaredAt: iso(at(31)), doneAt: null },
    ])
  })

  it('同じ発言の再送では、宣言の時刻も完了も変えない（Twitch の再送で完了が外れないように）', async () => {
    createStream('今日の配信', STARTED_AT)
    await declareTask(db, declaration('11111', 'たなか', '英単語を50個覚える', 'message-1'), at(5))
    await completeTask(db, doneBy('11111'), at(30))

    expect(await declareTask(db, declaration('11111', 'たなか', '英単語を50個覚える', 'message-1'), at(31))).toBe(true)

    expect(await readTaskDesk(db, at(31), 12)).toEqual([
      { userId: '11111', name: 'たなか', task: '英単語を50個覚える', declaredAt: iso(at(5)), doneAt: iso(at(30)) },
    ])
  })

  it('前の配信の宣言は、いまの配信の作業机に出ない（配信ごとに片付ける）', async () => {
    await declareInPreviousStream()
    createStream('今日の配信', STARTED_AT)

    expect(await readTaskDesk(db, at(5), 12)).toEqual([])
  })
})

describe('completeTask', () => {
  it('未完了の宣言に完了の時刻を付ける', async () => {
    createStream('今日の配信', STARTED_AT)
    await declareTask(db, declaration('11111', 'たなか', '英単語を50個覚える'), at(5))

    expect(await completeTask(db, doneBy('11111'), at(30))).toBe('completed')

    expect(await readTaskDesk(db, at(30), 12)).toEqual([
      { userId: '11111', name: 'たなか', task: '英単語を50個覚える', declaredAt: iso(at(5)), doneAt: iso(at(30)) },
    ])
  })

  it('もう完了していれば、完了の時刻を変えずに already-done を返す（再送や打ち直しで祝い直さない）', async () => {
    createStream('今日の配信', STARTED_AT)
    await declareTask(db, declaration('11111', 'たなか', '英単語を50個覚える'), at(5))
    await completeTask(db, doneBy('11111'), at(30))

    expect(await completeTask(db, doneBy('11111'), at(31))).toBe('already-done')

    expect((await readTaskDesk(db, at(31), 12))[0]?.doneAt).toBe(iso(at(30)))
  })

  it('同じ !done の再送では、そのあとに打ち直した新しい宣言を完了にしない', async () => {
    createStream('今日の配信', STARTED_AT)
    await declareTask(db, declaration('11111', 'たなか', '英単語を50個覚える', 'message-1'), at(5))
    await completeTask(db, doneBy('11111', 'done-message-1'), at(30))
    await declareTask(db, declaration('11111', 'たなか', '数学の問題集を3ページ', 'message-2'), at(31))

    // Twitch が最初の !done（done-message-1）を再送してきた
    expect(await completeTask(db, doneBy('11111', 'done-message-1'), at(32))).toBe('already-done')

    expect((await readTaskDesk(db, at(32), 12))[0]).toMatchObject({ task: '数学の問題集を3ページ', doneAt: null })
  })

  it('いまの配信で宣言していなければ no-task を返す', async () => {
    await declareInPreviousStream()
    createStream('今日の配信', STARTED_AT)

    expect(await completeTask(db, doneBy('11111'), at(30))).toBe('no-task')
  })

  it('配信していなければ offline を返す', async () => {
    expect(await completeTask(db, doneBy('11111'), at(30))).toBe('offline')
  })
})

describe('readTaskDesk', () => {
  it('未完了を宣言の新しい順に並べ、そのあとに完了を完了の新しい順に並べる', async () => {
    createStream('今日の配信', STARTED_AT)
    await declareTask(db, declaration('1', 'いちばん先に宣言した人', '作業A'), at(1))
    await declareTask(db, declaration('2', '先に完了した人', '作業B'), at(2))
    await declareTask(db, declaration('3', 'あとで完了した人', '作業C'), at(3))
    await declareTask(db, declaration('4', 'いちばんあとに宣言した人', '作業D'), at(4))
    await completeTask(db, doneBy('2'), at(10))
    await completeTask(db, doneBy('3'), at(20))

    const names = (await readTaskDesk(db, at(20), 12)).map((entry) => entry.name)

    expect(names).toEqual(['いちばんあとに宣言した人', 'いちばん先に宣言した人', 'あとで完了した人', '先に完了した人'])
  })

  it('上限を超えたら、完了した人から落とす（作業中の人を押し出さない）', async () => {
    createStream('今日の配信', STARTED_AT)
    await declareTask(db, declaration('1', '完了した人', '作業A'), at(1))
    await completeTask(db, doneBy('1'), at(2))
    await declareTask(db, declaration('2', '作業中の人その1', '作業B'), at(3))
    await declareTask(db, declaration('3', '作業中の人その2', '作業C'), at(4))

    const names = (await readTaskDesk(db, at(5), 2)).map((entry) => entry.name)

    expect(names).toEqual(['作業中の人その2', '作業中の人その1'])
  })

  it('配信していなければ空の一覧を返す（配信の前後にOBSを開いたままにするので失敗にしない）', async () => {
    expect(await readTaskDesk(db, at(5), 12)).toEqual([])
  })
})

describe('removeModeratedTasks', () => {
  /** 2人が宣言している配信中の作業机を作る */
  const deskWithTwoViewers = async (): Promise<void> => {
    createStream('今日の配信', STARTED_AT)
    await declareTask(db, declaration('11111', 'たなか', '英単語を50個覚える', 'message-tanaka'), at(1))
    await declareTask(db, declaration('22222', 'あらし', '見せたくない文言', 'message-arashi'), at(2))
  }

  it('消された発言が宣言の発言なら、その宣言を消して true を返す', async () => {
    await deskWithTwoViewers()

    expect(await removeModeratedTasks(db, { kind: 'delete', messageId: 'message-arashi' }, at(3))).toBe(true)

    expect((await readTaskDesk(db, at(3), 12)).map((entry) => entry.userId)).toEqual(['11111'])
  })

  it('消された発言が宣言の発言でなければ、何も消さず false を返す', async () => {
    await deskWithTwoViewers()

    expect(await removeModeratedTasks(db, { kind: 'delete', messageId: 'ふつうの発言' }, at(3))).toBe(false)

    expect(await readTaskDesk(db, at(3), 12)).toHaveLength(2)
  })

  it('その人の発言がすべて消されたら（BAN・タイムアウト）、その人の宣言を消す', async () => {
    await deskWithTwoViewers()

    expect(await removeModeratedTasks(db, { kind: 'clearUser', userId: '22222' }, at(3))).toBe(true)

    expect((await readTaskDesk(db, at(3), 12)).map((entry) => entry.userId)).toEqual(['11111'])
  })

  it('チャットがすべて消されたら、いまの配信の宣言をすべて消す', async () => {
    await deskWithTwoViewers()

    expect(await removeModeratedTasks(db, { kind: 'clear' }, at(3))).toBe(true)

    expect(await readTaskDesk(db, at(3), 12)).toEqual([])
  })

  it('前の配信の宣言は、チャットがすべて消されても残す（記録として残っている配信を書き換えない）', async () => {
    await declareInPreviousStream()
    createStream('今日の配信', STARTED_AT)

    expect(await removeModeratedTasks(db, { kind: 'clear' }, at(3))).toBe(false)

    const remaining = db.sqlite.prepare('SELECT COUNT(*) AS count FROM task_declarations').get() as { count: number }
    expect(remaining.count).toBe(1)
  })
})

describe('作業した時間の合計', () => {
  it('打ち直す前の完了した宣言の時間を、合計に残す（1人1行でも時間が消えない）', async () => {
    createStream('今日の配信', STARTED_AT)
    // たなか: 5分〜30分（25分）で完了し、31分に打ち直していまも作業中
    await declareTask(db, declaration('11111', 'たなか', '英単語を50個覚える', 'message-1'), at(5))
    await completeTask(db, doneBy('11111'), at(30))
    await declareTask(db, declaration('11111', 'たなか', '数学の問題集を3ページ', 'message-2'), at(31))

    // 41分の時点: 前の宣言の25分 + いまの宣言の10分
    expect(await readCurrentWorkTime(db, at(41))).toEqual({ people: 1, totalMs: 35 * MINUTE, working: 1 })
  })

  it('完了せずに打ち直したときは、打ち直すまでの時間を残す', async () => {
    createStream('今日の配信', STARTED_AT)
    await declareTask(db, declaration('11111', 'たなか', '英単語を50個覚える', 'message-1'), at(5))
    await declareTask(db, declaration('11111', 'たなか', '数学の問題集を3ページ', 'message-2'), at(20))

    // 30分の時点: 前の宣言の15分 + いまの宣言の10分
    expect(await readCurrentWorkTime(db, at(30))).toEqual({ people: 1, totalMs: 25 * MINUTE, working: 1 })
  })

  it('同じ発言の再送では、打ち直しとして時間を足し込まない', async () => {
    createStream('今日の配信', STARTED_AT)
    await declareTask(db, declaration('11111', 'たなか', '英単語を50個覚える', 'message-1'), at(5))
    await completeTask(db, doneBy('11111'), at(30))
    await declareTask(db, declaration('11111', 'たなか', '英単語を50個覚える', 'message-1'), at(31))

    expect(await readCurrentWorkTime(db, at(40))).toEqual({ people: 1, totalMs: 25 * MINUTE, working: 0 })
  })

  it('配信していない・まだ誰も宣言していなければ null を返す', async () => {
    expect(await readCurrentWorkTime(db, at(5))).toBeNull()

    createStream('今日の配信', STARTED_AT)
    expect(await readCurrentWorkTime(db, at(5))).toBeNull()
  })

  it('前の配信の宣言は、いまの配信の合計に入らない', async () => {
    await declareInPreviousStream()
    createStream('今日の配信', STARTED_AT)
    await declareTask(db, declaration('22222', 'すずき', '洗濯物をたたむ'), at(10))

    expect(await readCurrentWorkTime(db, at(20))).toEqual({ people: 1, totalMs: 10 * MINUTE, working: 1 })
  })

  it('終わった配信の合計は、完了しなかった宣言を渡した時刻（配信の終わり）で打ち切る', async () => {
    // 前の配信: たなかが 13:00 に宣言し、完了しないまま 15:00 に配信が終わった
    await declareInPreviousStream()

    expect(await readSessionWorkTime(db, '前の配信', Date.parse('2026-10-02T15:00:00.000Z'))).toEqual({
      people: 1,
      totalMs: 120 * MINUTE,
      working: 1,
    })
  })

  it('宣言が無い配信の合計は null を返す（0 と出さないため）', async () => {
    createStream('今日の配信', STARTED_AT)

    expect(await readSessionWorkTime(db, '今日の配信', at(60))).toBeNull()
  })
})

describe('readTaskDeskSnapshot', () => {
  it('作業机の行と、読んだ時刻つきの合計をまとめて返す', async () => {
    createStream('今日の配信', STARTED_AT)
    await declareTask(db, declaration('11111', 'たなか', '英単語を50個覚える'), at(5))

    expect(await readTaskDeskSnapshot(db, at(15), 12)).toEqual({
      entries: [{ userId: '11111', name: 'たなか', task: '英単語を50個覚える', declaredAt: iso(at(5)), doneAt: null }],
      workTime: { people: 1, totalMs: 10 * MINUTE, working: 1, measuredAt: iso(at(15)) },
    })
  })

  it('合計は作業机に並べる人数の上限に関係なく、全員ぶんを足す', async () => {
    createStream('今日の配信', STARTED_AT)
    await declareTask(db, declaration('1', 'たなか', '作業A'), at(0))
    await declareTask(db, declaration('2', 'すずき', '作業B'), at(0))

    const snapshot = await readTaskDeskSnapshot(db, at(10), 1)

    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.workTime).toMatchObject({ people: 2, totalMs: 20 * MINUTE })
  })

  it('配信していなければ、空の行と null の合計を返す', async () => {
    expect(await readTaskDeskSnapshot(db, at(5), 12)).toEqual({ entries: [], workTime: null })
  })
})
