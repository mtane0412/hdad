/**
 * 漢字クイズの出題（kanji-quiz-issue.ts）のテスト
 *
 * チャンネルポイントの交換と試し再生は、同じ配信で出していない問題を1問選び、出題の行を D1 に入れてから合成ページへ押し出す。
 * 行を押し出す前に入れるのは、合成ページが流しはじめて出題を開く（POST /api/overlay/kanji-quiz/open）までに行が要るため。
 * 重みのある級の問題をすべて出し終えたら、エラーにせず出した回数がいちばん少ない問題から選び直す。
 */
import { describe, expect, it } from 'vitest'
import { parseKanjiQuizMessage } from '../src/kanji-quiz/call'
import { singleGradeWeights } from '../src/kanji-quiz/grade'
import type { KanjiQuizProblem } from '../src/kanji-quiz/problems'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeDatabase } from './fake-database'
import { issueKanjiQuiz } from './kanji-quiz-issue'
import { readKanjiQuizWordCounts } from './kanji-quiz-store'
import { recordStreamOnline } from './stats-store'

const now = Date.UTC(2026, 9, 10, 12, 0, 0)

/** 6級を2問持つ問題集 */
const problems: readonly KanjiQuizProblem[] = [
  { word: '境内', readings: ['けいだい'], grade: '6', explanation: '神社や寺の敷地の中。' },
  { word: '仮病', readings: ['けびょう'], grade: '6', explanation: '病気のふりをすること。' },
]

/** 6級だけを出す重み */
const sixOnly = singleGradeWeights('6')

/** BGM だけを選んだ音の設定（呼び出し側が音声のURLに置き換えたもの） */
const sound = {
  slots: { bgm: '/api/media/media-thinking?key=overlay-key', start: null, countdown: null, correct: null, timeUp: null },
  bgmVolume: 0.3,
  effectVolume: 0.6,
}

/** 配信中の D1 と配送先 */
const createLiveDeps = async () => {
  const db = createFakeDatabase()
  await recordStreamOnline(db, { id: 'stream-1', startedAt: now - 60_000 })
  const alertChannel = createFakeAlertChannel()
  return { db, alertChannel }
}

describe('issueKanjiQuiz', () => {
  it('選んだ問題の行を入れてから、交換した人の名前と音の設定と一緒に押し出す', async () => {
    const { db, alertChannel } = await createLiveDeps()

    const call = await issueKanjiQuiz({ db, alerts: alertChannel.namespace, now, random: () => 0, id: 'quiz-1' }, { weights: sixOnly, requesterName: '田中太郎', rehearsal: false, sound }, problems)

    expect(call).toEqual({ id: 'quiz-1', problem: problems[0], requesterName: '田中太郎', sound })
    expect(alertChannel.pushedKanjiQuizzes).toEqual([call])
    // 合成ページの読み取りがそのまま読める形で押し出す
    expect(parseKanjiQuizMessage(JSON.stringify(call))).toEqual({ type: 'call', call })
    expect(await readKanjiQuizWordCounts(db, now)).toEqual(new Map([['境内', 1]]))
  })

  it('同じ配信で2回出題すると、2回目は1回目と違う問題を選ぶ', async () => {
    const { db, alertChannel } = await createLiveDeps()
    const deps = { db, alerts: alertChannel.namespace, now, random: () => 0 }

    await issueKanjiQuiz({ ...deps, id: 'quiz-1' }, { weights: sixOnly, requesterName: '田中太郎', rehearsal: false, sound }, problems)
    const second = await issueKanjiQuiz({ ...deps, id: 'quiz-2' }, { weights: sixOnly, requesterName: null, rehearsal: true, sound }, problems)

    expect(second.problem.word).toBe('仮病')
  })

  it('選べる問題をすべて出し終えても、エラーにせず一巡して出題する', async () => {
    const { db, alertChannel } = await createLiveDeps()
    const deps = { db, alerts: alertChannel.namespace, now, random: () => 0 }
    await issueKanjiQuiz({ ...deps, id: 'quiz-1' }, { weights: sixOnly, requesterName: '田中太郎', rehearsal: false, sound }, problems)
    await issueKanjiQuiz({ ...deps, id: 'quiz-2' }, { weights: sixOnly, requesterName: '田中太郎', rehearsal: false, sound }, problems)

    const call = await issueKanjiQuiz({ ...deps, id: 'quiz-3' }, { weights: sixOnly, requesterName: '田中太郎', rehearsal: false, sound }, problems)

    // 2問とも1回ずつ出したので、2巡目の先頭の「境内」を出す
    expect(call.problem.word).toBe('境内')
    expect(alertChannel.pushedKanjiQuizzes.map(({ id }) => id)).toEqual(['quiz-1', 'quiz-2', 'quiz-3'])
    expect(alertChannel.pushedKanjiQuizNotices).toEqual([])
  })

  it('押し出しに失敗したら、流れなかった問題を「出した」に数えないよう行を消してから投げる', async () => {
    const db = createFakeDatabase()
    await recordStreamOnline(db, { id: 'stream-1', startedAt: now - 60_000 })
    const failingChannel = createFakeAlertChannel({ shouldFail: true })

    await expect(issueKanjiQuiz({ db, alerts: failingChannel.namespace, now, random: () => 0, id: 'quiz-1' }, { weights: sixOnly, requesterName: '田中太郎', rehearsal: false, sound }, problems)).rejects.toThrow()

    expect(await readKanjiQuizWordCounts(db, now)).toEqual(new Map())
  })
})
