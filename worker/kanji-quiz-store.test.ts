/**
 * 漢字クイズの出題と回答の記録（kanji-quiz-store.ts）のテスト
 *
 * メモリ上のSQLite（fake-database.ts）に migrations/ を適用して確かめる。特に重要なのは次の点。
 * - 回答を受け付けるのは、合成ページが出題を開いてから（熟語が出てから）制限時間と遅れの余裕のあいだだけ
 * - 最初に正解した1人だけが正解者になる（2人目以降は正解者にならない）
 * - 同じ出題を2回開いても（合成ページを2つ開いていても）、受け付ける長さを延ばさない
 * - 同じ配信で出した問題の熟語を、次の出題から外せるよう読み出せる（配信していなければ外すものは無い）
 */
import { describe, expect, it } from 'vitest'
import { ANSWER_LIMIT_MS, GRADE_INTRO_MS } from '../src/kanji-quiz/scene'
import { createFakeDatabase } from './fake-database'
import { KANJI_QUIZ_GRACE_MS, answerKanjiQuiz, openKanjiQuiz, readUsedKanjiQuizWords, recordKanjiQuiz } from './kanji-quiz-store'
import { recordStreamOffline, recordStreamOnline } from './stats-store'

const now = Date.UTC(2026, 9, 10, 12, 0, 0)
/** 「境内」の出題 */
const keidaiQuiz = { id: 'quiz-keidai', word: '境内' }
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

  it('選んだ出題なら開けたことを返し、選んでいない出題の識別子なら行を作らずに開けなかったことを返す', async () => {
    const db = createFakeDatabase()
    await recordKanjiQuiz(db, keidaiQuiz, now)

    expect(await openKanjiQuiz(db, keidaiQuiz.id, now)).toBe(true)
    // 合成ページから熟語を受け取って作らない
    expect(await openKanjiQuiz(db, 'quiz-unknown', now)).toBe(false)
  })
})

describe('readUsedKanjiQuizWords', () => {
  it('配信中なら、その配信が始まってから選んだ問題の熟語を返す', async () => {
    const db = createFakeDatabase()
    await recordKanjiQuiz(db, { id: 'quiz-before', word: '納屋' }, now - 60 * 60 * 1000)
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
