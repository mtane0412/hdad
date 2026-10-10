/**
 * 漢字クイズの呼び出し（call.ts）のテスト
 *
 * Worker（worker/kanji-quiz-issue.ts）が押し出す1回ぶんの出題（問題1問と、チャンネルポイントを交換して出題させた人の名前）を、合成ページが読む。
 * 同じ経路で、最初の正解者（type: answer）と出題できなかった理由（type: failure）も届く（issue #301）。形が違えば黙って流さずに投げる。
 */
import { describe, expect, it } from 'vitest'
import { parseKanjiQuizMessage } from './call'

const call = {
  id: '出題ID',
  problem: { word: '境内', readings: ['けいだい'], grade: '6', explanation: '神社や寺の敷地の中。' },
  requesterName: '田中太郎',
}

describe('parseKanjiQuizMessage', () => {
  it('type を持たないものは出題として読む', () => {
    expect(parseKanjiQuizMessage(JSON.stringify(call))).toEqual({ type: 'call', call })
  })

  it('試し再生の出題は、出題させた人を持たない（null）', () => {
    const demo = { ...call, requesterName: null }

    expect(parseKanjiQuizMessage(JSON.stringify(demo))).toEqual({ type: 'call', call: demo })
  })

  it('JSONとして読めなければ投げる', () => {
    expect(() => parseKanjiQuizMessage('{')).toThrowError(/JSON/)
  })

  it('識別子が無い・問題の形が違う（知らない級など）なら投げる', () => {
    expect(() => parseKanjiQuizMessage(JSON.stringify({ problem: call.problem, requesterName: null }))).toThrowError(/形/)
    expect(() => parseKanjiQuizMessage(JSON.stringify({ ...call, requesterName: 42 }))).toThrowError(/形/)
    expect(() => parseKanjiQuizMessage(JSON.stringify({ ...call, problem: { ...call.problem, grade: '11' } }))).toThrowError(/級/)
  })

  it('最初の正解者は、出題の識別子と正解者の名前を読む', () => {
    expect(parseKanjiQuizMessage(JSON.stringify({ type: 'answer', quizId: '出題ID', userName: '山田花子' }))).toEqual({
      type: 'answer',
      quizId: '出題ID',
      userName: '山田花子',
    })
  })

  it('出題できなかった理由は、その文を読む', () => {
    const message = '漢字クイズの問題集の6級の問題は、この配信ですべて出しました（4問）'

    expect(parseKanjiQuizMessage(JSON.stringify({ type: 'failure', message }))).toEqual({ type: 'failure', message })
  })

  it('正解者の名前が無い・知らない type なら投げる', () => {
    expect(() => parseKanjiQuizMessage(JSON.stringify({ type: 'answer', quizId: '出題ID' }))).toThrowError(/正解者/)
    expect(() => parseKanjiQuizMessage(JSON.stringify({ type: 'failure' }))).toThrowError(/失敗/)
    expect(() => parseKanjiQuizMessage(JSON.stringify({ type: 'hint', quizId: '出題ID' }))).toThrowError(/hint/)
  })
})
