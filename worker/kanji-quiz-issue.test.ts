/**
 * 漢字クイズの出題（kanji-quiz-issue.ts）のテスト
 *
 * チャンネルポイントの交換と試し再生は、同じ配信で出していない問題を1問選び、出題の行を D1 に入れてから合成ページへ押し出す。
 * 行を押し出す前に入れるのは、合成ページが流しはじめて出題を開く（POST /api/overlay/kanji-quiz/open）までに行が要るため。
 * 選べる問題が尽きたら、黙って重複させずに合成ページの素材の箱へ失敗を押し出し、投げる（issue #301）。
 */
import { describe, expect, it } from 'vitest'
import { parseKanjiQuizMessage } from '../src/kanji-quiz/call'
import type { KanjiQuizProblem } from '../src/kanji-quiz/problems'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeDatabase } from './fake-database'
import { KanjiQuizExhaustedError } from './kanji-quiz-call'
import { issueKanjiQuiz } from './kanji-quiz-issue'
import { readUsedKanjiQuizWords } from './kanji-quiz-store'
import { recordStreamOnline } from './stats-store'

const now = Date.UTC(2026, 9, 10, 12, 0, 0)

/** 6級を2問持つ問題集 */
const problems: readonly KanjiQuizProblem[] = [
  { word: '境内', readings: ['けいだい'], grade: '6', explanation: '神社や寺の敷地の中。' },
  { word: '仮病', readings: ['けびょう'], grade: '6', explanation: '病気のふりをすること。' },
]

/** 配信中の D1 と配送先 */
const createLiveDeps = async () => {
  const db = createFakeDatabase()
  await recordStreamOnline(db, { id: 'stream-1', startedAt: now - 60_000 })
  const alertChannel = createFakeAlertChannel()
  return { db, alertChannel }
}

describe('issueKanjiQuiz', () => {
  it('選んだ問題の行を入れてから、交換した人の名前と一緒に押し出す', async () => {
    const { db, alertChannel } = await createLiveDeps()

    const call = await issueKanjiQuiz({ db, alerts: alertChannel.namespace, now, random: () => 0, id: 'quiz-1' }, { grade: '6', requesterName: '田中太郎' }, problems)

    expect(call).toEqual({ id: 'quiz-1', problem: problems[0], requesterName: '田中太郎' })
    expect(alertChannel.pushedKanjiQuizzes).toEqual([call])
    // 合成ページの読み取りがそのまま読める形で押し出す
    expect(parseKanjiQuizMessage(JSON.stringify(call))).toEqual({ type: 'call', call })
    expect(await readUsedKanjiQuizWords(db, now)).toEqual(new Set(['境内']))
  })

  it('同じ配信で2回出題すると、2回目は1回目と違う問題を選ぶ', async () => {
    const { db, alertChannel } = await createLiveDeps()
    const deps = { db, alerts: alertChannel.namespace, now, random: () => 0 }

    await issueKanjiQuiz({ ...deps, id: 'quiz-1' }, { grade: '6', requesterName: '田中太郎' }, problems)
    const second = await issueKanjiQuiz({ ...deps, id: 'quiz-2' }, { grade: '6', requesterName: null }, problems)

    expect(second.problem.word).toBe('仮病')
  })

  it('選べる問題が尽きたら、素材の箱へ失敗を押し出して投げ、問題は押し出さない', async () => {
    const { db, alertChannel } = await createLiveDeps()
    const deps = { db, alerts: alertChannel.namespace, now, random: () => 0 }
    await issueKanjiQuiz({ ...deps, id: 'quiz-1' }, { grade: '6', requesterName: '田中太郎' }, problems)
    await issueKanjiQuiz({ ...deps, id: 'quiz-2' }, { grade: '6', requesterName: '田中太郎' }, problems)

    await expect(issueKanjiQuiz({ ...deps, id: 'quiz-3' }, { grade: '6', requesterName: '田中太郎' }, problems)).rejects.toThrow(KanjiQuizExhaustedError)

    expect(alertChannel.pushedKanjiQuizzes.map(({ id }) => id)).toEqual(['quiz-1', 'quiz-2'])
    expect(alertChannel.pushedKanjiQuizNotices).toEqual([{ type: 'failure', message: expect.stringContaining('すべて出しました') }])
  })
})
