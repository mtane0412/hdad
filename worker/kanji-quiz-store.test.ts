/**
 * 漢字クイズの出題と回答の記録（kanji-quiz-store.ts）のテスト
 *
 * メモリ上のSQLite（fake-database.ts）に migrations/ を適用して確かめる。特に重要なのは次の点。
 * - 回答を受け付けるのは、合成ページが出題を開いてから（熟語が出てから）制限時間と遅れの余裕のあいだだけ
 * - 最初に正解した1人だけが正解者になる（2人目以降は正解者にならない）
 * - 同じ出題を2回開いても（合成ページを2つ開いていても）、受け付ける長さを延ばさない
 * - 同じ配信で出した問題の熟語を、次の出題から外せるよう読み出せる（配信していなければ外すものは無い）
 * - 時間切れ（正解者なし）のときだけ配信の停止を始め、取り消しと停止はどちらか一方しか通らない。同じ出題で2回止めない（issue #302）
 */
import { describe, expect, it } from 'vitest'
import { ANSWER_LIMIT_MS, GRADE_INTRO_MS } from '../src/kanji-quiz/scene'
import { createFakeDatabase } from './fake-database'
import {
  KANJI_QUIZ_GRACE_MS,
  answerKanjiQuiz,
  beginKanjiQuizStop,
  cancelKanjiQuizStops,
  claimKanjiQuizStop,
  openKanjiQuiz,
  readUsedKanjiQuizWords,
  recordKanjiQuiz,
} from './kanji-quiz-store'
import { recordStreamOffline, recordStreamOnline } from './stats-store'

const now = Date.UTC(2026, 9, 10, 12, 0, 0)
/** 「境内」の出題 */
const keidaiQuiz = { id: 'quiz-keidai', word: '境内', rehearsal: false }
/** 熟語が出て回答を受け付けはじめる時刻（開いてから級を出しているあいだは受け付けない） */
const acceptsFrom = now + GRADE_INTRO_MS

describe('answerKanjiQuiz', () => {
  it('熟語が出たあとに正しく答えた最初の人を、正解者として返す', async () => {
    const db = createFakeDatabase()
    await recordKanjiQuiz(db, keidaiQuiz, now)
    await openKanjiQuiz(db, keidaiQuiz.id, now)

    expect(await answerKanjiQuiz(db, { words: ['境内'], userName: '山田花子' }, acceptsFrom + 3000)).toEqual(['quiz-keidai'])
  })

  it('2人目の正解者は返さない（最初の正解者だけを画面に出す）', async () => {
    const db = createFakeDatabase()
    await recordKanjiQuiz(db, keidaiQuiz, now)
    await openKanjiQuiz(db, keidaiQuiz.id, now)
    await answerKanjiQuiz(db, { words: ['境内'], userName: '山田花子' }, acceptsFrom + 3000)

    expect(await answerKanjiQuiz(db, { words: ['境内'], userName: '田中太郎' }, acceptsFrom + 4000)).toEqual([])
  })

  it('ほかの熟語の読みの回答では正解者にならない', async () => {
    const db = createFakeDatabase()
    await recordKanjiQuiz(db, keidaiQuiz, now)
    await openKanjiQuiz(db, keidaiQuiz.id, now)

    expect(await answerKanjiQuiz(db, { words: ['納屋'], userName: '田中太郎' }, acceptsFrom + 2000)).toEqual([])
  })

  it('級を出しているあいだ（熟語が出る前）の回答は受け付けない', async () => {
    const db = createFakeDatabase()
    await recordKanjiQuiz(db, keidaiQuiz, now)
    await openKanjiQuiz(db, keidaiQuiz.id, now)

    expect(await answerKanjiQuiz(db, { words: ['境内'], userName: '山田花子' }, acceptsFrom - 1)).toEqual([])
  })

  it('制限時間と遅れの余裕を過ぎた回答は受け付けない', async () => {
    const db = createFakeDatabase()
    await recordKanjiQuiz(db, keidaiQuiz, now)
    await openKanjiQuiz(db, keidaiQuiz.id, now)

    expect(await answerKanjiQuiz(db, { words: ['境内'], userName: '山田花子' }, acceptsFrom + ANSWER_LIMIT_MS + KANJI_QUIZ_GRACE_MS)).toEqual([])
  })

  it('選んだだけでまだ開いていない（合成ページが流していない）出題は受け付けない', async () => {
    const db = createFakeDatabase()
    await recordKanjiQuiz(db, keidaiQuiz, now)

    expect(await answerKanjiQuiz(db, { words: ['境内'], userName: '山田花子' }, acceptsFrom + 3000)).toEqual([])
  })
})

describe('openKanjiQuiz', () => {
  it('同じ出題を2回開いても、受け付ける長さは最初に開いたときから数える', async () => {
    const db = createFakeDatabase()
    await recordKanjiQuiz(db, keidaiQuiz, now)
    await openKanjiQuiz(db, keidaiQuiz.id, now)
    // 合成ページを2つ開いていると、10秒遅れてもう一方からも開かれることがある
    await openKanjiQuiz(db, keidaiQuiz.id, now + 10_000)

    expect(await answerKanjiQuiz(db, { words: ['境内'], userName: '山田花子' }, acceptsFrom + ANSWER_LIMIT_MS + KANJI_QUIZ_GRACE_MS)).toEqual([])
  })

  it('選んだ出題なら受付の締め切りの時刻を返し、選んでいない出題の識別子なら行を作らずに null を返す', async () => {
    const db = createFakeDatabase()
    await recordKanjiQuiz(db, keidaiQuiz, now)

    expect(await openKanjiQuiz(db, keidaiQuiz.id, now)).toBe(acceptsFrom + ANSWER_LIMIT_MS + KANJI_QUIZ_GRACE_MS)
    // 合成ページから熟語を受け取って作らない
    expect(await openKanjiQuiz(db, 'quiz-unknown', now)).toBeNull()
  })

  it('2回目に開いたときも、最初に開いたときの締め切りを返す', async () => {
    const db = createFakeDatabase()
    await recordKanjiQuiz(db, keidaiQuiz, now)
    await openKanjiQuiz(db, keidaiQuiz.id, now)

    expect(await openKanjiQuiz(db, keidaiQuiz.id, now + 10_000)).toBe(acceptsFrom + ANSWER_LIMIT_MS + KANJI_QUIZ_GRACE_MS)
  })
})

describe('readUsedKanjiQuizWords', () => {
  it('配信中なら、その配信が始まってから選んだ問題の熟語を返す', async () => {
    const db = createFakeDatabase()
    await recordKanjiQuiz(db, { id: 'quiz-before', word: '納屋', rehearsal: false }, now - 60 * 60 * 1000)
    await recordStreamOnline(db, { id: 'stream-1', startedAt: now - 30 * 60 * 1000 })
    await recordKanjiQuiz(db, keidaiQuiz, now - 10 * 60 * 1000)

    expect(await readUsedKanjiQuizWords(db, now)).toEqual(new Set(['境内']))
  })

  it('配信していなければ、外す熟語は無い', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'stream-1', startedAt: now - 30 * 60 * 1000 })
    await recordKanjiQuiz(db, keidaiQuiz, now - 10 * 60 * 1000)
    await recordStreamOffline(db, now - 5 * 60 * 1000)

    expect(await readUsedKanjiQuizWords(db, now)).toEqual(new Set())
  })
})

/** 受付の締め切り（開いてから、級・制限時間・遅れの余裕のあと） */
const closesAt = acceptsFrom + ANSWER_LIMIT_MS + KANJI_QUIZ_GRACE_MS
/** 配信を止めるまでの猶予（テストでの値） */
const graceMs = 10_000

/** 出題を選んで開いた状態を作る */
const openedQuiz = async (quiz: { id: string; word: string; rehearsal: boolean } = keidaiQuiz) => {
  const db = createFakeDatabase()
  await recordKanjiQuiz(db, quiz, now)
  await openKanjiQuiz(db, quiz.id, now)
  return db
}

describe('beginKanjiQuizStop', () => {
  it('締め切りを過ぎて正解者がいなければ停止を始め、試し再生かどうかを返す', async () => {
    const db = await openedQuiz()

    expect(await beginKanjiQuizStop(db, keidaiQuiz.id, closesAt, graceMs)).toEqual({ rehearsal: false })
  })

  it('試し再生の出題なら、試し再生であることを返す', async () => {
    const db = await openedQuiz({ ...keidaiQuiz, rehearsal: true })

    expect(await beginKanjiQuizStop(db, keidaiQuiz.id, closesAt, graceMs)).toEqual({ rehearsal: true })
  })

  it('正解者がいれば停止を始めない', async () => {
    const db = await openedQuiz()
    await answerKanjiQuiz(db, { words: ['境内'], userName: '山田花子' }, acceptsFrom + 3000)

    expect(await beginKanjiQuizStop(db, keidaiQuiz.id, closesAt, graceMs)).toBeNull()
  })

  it('締め切りの前なら停止を始めない（まだ正解が届くかもしれない）', async () => {
    const db = await openedQuiz()

    expect(await beginKanjiQuizStop(db, keidaiQuiz.id, closesAt - 1, graceMs)).toBeNull()
  })

  it('開いていない出題では停止を始めない', async () => {
    const db = createFakeDatabase()
    await recordKanjiQuiz(db, keidaiQuiz, now)

    expect(await beginKanjiQuizStop(db, keidaiQuiz.id, closesAt, graceMs)).toBeNull()
  })

  it('同じ出題で2回は始めない（アラームが2回鳴っても猶予を延ばさない）', async () => {
    const db = await openedQuiz()
    await beginKanjiQuizStop(db, keidaiQuiz.id, closesAt, graceMs)

    expect(await beginKanjiQuizStop(db, keidaiQuiz.id, closesAt + 1000, graceMs)).toBeNull()
  })
})

describe('claimKanjiQuizStop', () => {
  it('猶予が尽きたら、停止の鍵を1回だけ確保できる', async () => {
    const db = await openedQuiz()
    await beginKanjiQuizStop(db, keidaiQuiz.id, closesAt, graceMs)

    expect(await claimKanjiQuizStop(db, keidaiQuiz.id, closesAt + graceMs)).toBe(true)
    // 同じ出題で2回止めない
    expect(await claimKanjiQuizStop(db, keidaiQuiz.id, closesAt + graceMs + 1000)).toBe(false)
  })

  it('猶予が尽きる前は確保できない', async () => {
    const db = await openedQuiz()
    await beginKanjiQuizStop(db, keidaiQuiz.id, closesAt, graceMs)

    expect(await claimKanjiQuizStop(db, keidaiQuiz.id, closesAt + graceMs - 1)).toBe(false)
  })

  it('取り消されていたら確保できない', async () => {
    const db = await openedQuiz()
    await beginKanjiQuizStop(db, keidaiQuiz.id, closesAt, graceMs)
    await cancelKanjiQuizStops(db, closesAt + 3000)

    expect(await claimKanjiQuizStop(db, keidaiQuiz.id, closesAt + graceMs)).toBe(false)
  })

  it('試し再生の出題では確保できない（配信を止めない）', async () => {
    const db = await openedQuiz({ ...keidaiQuiz, rehearsal: true })
    await beginKanjiQuizStop(db, keidaiQuiz.id, closesAt, graceMs)

    expect(await claimKanjiQuizStop(db, keidaiQuiz.id, closesAt + graceMs)).toBe(false)
  })

  it('停止を始めていない出題では確保できない', async () => {
    const db = await openedQuiz()

    expect(await claimKanjiQuizStop(db, keidaiQuiz.id, closesAt + graceMs)).toBe(false)
  })
})

describe('cancelKanjiQuizStops', () => {
  it('猶予のあいだの停止を取り消し、取り消した出題の識別子を返す', async () => {
    const db = await openedQuiz()
    await beginKanjiQuizStop(db, keidaiQuiz.id, closesAt, graceMs)

    expect(await cancelKanjiQuizStops(db, closesAt + 3000)).toEqual([keidaiQuiz.id])
    // 2回目の取り消しでは何も取り消さない
    expect(await cancelKanjiQuizStops(db, closesAt + 4000)).toEqual([])
  })

  it('もう止める命令を送った出題は取り消せない', async () => {
    const db = await openedQuiz()
    await beginKanjiQuizStop(db, keidaiQuiz.id, closesAt, graceMs)
    await claimKanjiQuizStop(db, keidaiQuiz.id, closesAt + graceMs)

    expect(await cancelKanjiQuizStops(db, closesAt + graceMs + 1000)).toEqual([])
  })

  it('停止を始めていない出題は取り消さない', async () => {
    const db = await openedQuiz()

    expect(await cancelKanjiQuizStops(db, closesAt)).toEqual([])
  })
})
