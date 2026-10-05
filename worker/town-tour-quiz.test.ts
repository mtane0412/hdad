/**
 * 都道府県当てクイズの出題と回答の記録（town-tour-quiz.ts）のテスト
 *
 * メモリ上のSQLite（fake-database.ts）に migrations/ を適用して確かめる。特に重要なのは次の3点。
 * - 最初に正解した1人だけが正解者になる（2人目以降・同じ発言の再送では正解者にならない）
 * - 受け付ける長さ（クイズの長さと、届くまでの遅れの余裕）を過ぎた回答は受け付けない
 * - 同じ出題を2回開いても（合成ページを2つ開いていても）、受け付ける長さを延ばさない
 */
import { describe, expect, it } from 'vitest'
import { QUIZ_MS } from '../src/town-tour/quiz'
import { createFakeDatabase } from './fake-database'
import { QUIZ_GRACE_MS, answerTownTourQuiz, openTownTourQuiz } from './town-tour-quiz'

const now = Date.UTC(2026, 9, 5, 12, 0, 0)
/** 北海道石狩郡当別町の出題 */
const tobetsuQuiz = { id: 'quiz-tobetsu', code: '01303', prefecture: '北海道' }

describe('answerTownTourQuiz', () => {
  it('出題中に正しい都道府県を答えた最初の人を、正解者として返す', async () => {
    const db = createFakeDatabase()
    await openTownTourQuiz(db, tobetsuQuiz, now)

    expect(await answerTownTourQuiz(db, { prefecture: '北海道', userName: '山田花子' }, now + 3000)).toEqual(['quiz-tobetsu'])
  })

  it('2人目の正解者は返さない（最初の正解者だけを画面に出す）', async () => {
    const db = createFakeDatabase()
    await openTownTourQuiz(db, tobetsuQuiz, now)
    await answerTownTourQuiz(db, { prefecture: '北海道', userName: '山田花子' }, now + 3000)

    expect(await answerTownTourQuiz(db, { prefecture: '北海道', userName: '田中太郎' }, now + 4000)).toEqual([])
  })

  it('違う都道府県の回答では正解者にならず、あとから正しく答えた人が正解者になる', async () => {
    const db = createFakeDatabase()
    await openTownTourQuiz(db, tobetsuQuiz, now)

    expect(await answerTownTourQuiz(db, { prefecture: '青森県', userName: '田中太郎' }, now + 2000)).toEqual([])
    expect(await answerTownTourQuiz(db, { prefecture: '北海道', userName: '山田花子' }, now + 5000)).toEqual(['quiz-tobetsu'])
  })

  it('受け付ける長さ（クイズの長さと遅れの余裕）を過ぎた回答は受け付けない', async () => {
    const db = createFakeDatabase()
    await openTownTourQuiz(db, tobetsuQuiz, now)

    expect(await answerTownTourQuiz(db, { prefecture: '北海道', userName: '山田花子' }, now + QUIZ_MS + QUIZ_GRACE_MS)).toEqual([])
  })

  it('出題していなければ、何も返さない', async () => {
    const db = createFakeDatabase()

    expect(await answerTownTourQuiz(db, { prefecture: '北海道', userName: '山田花子' }, now)).toEqual([])
  })
})

describe('openTownTourQuiz', () => {
  it('同じ出題を2回開いても、受け付ける長さは最初に開いたときから数える', async () => {
    const db = createFakeDatabase()
    await openTownTourQuiz(db, tobetsuQuiz, now)
    // 合成ページを2つ開いていると、10秒遅れてもう一方からも開かれることがある
    await openTownTourQuiz(db, tobetsuQuiz, now + 10_000)

    expect(await answerTownTourQuiz(db, { prefecture: '北海道', userName: '山田花子' }, now + QUIZ_MS + QUIZ_GRACE_MS)).toEqual([])
  })

  it('1日より前の出題は、次に開いたときに消す（増え続けないように）', async () => {
    const db = createFakeDatabase()
    await openTownTourQuiz(db, tobetsuQuiz, now)
    await openTownTourQuiz(db, { id: 'quiz-chiyoda', code: '13101', prefecture: '東京都' }, now + 25 * 60 * 60 * 1000)

    expect(db.sqlite.prepare('SELECT id FROM town_tour_quizzes').all()).toEqual([{ id: 'quiz-chiyoda' }])
  })
})
