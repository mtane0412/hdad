/**
 * 漢字クイズの呼び出し（call.ts）のテスト
 *
 * Worker（worker/kanji-quiz-call.ts）が押し出す1回ぶんの出題（問題1問と、チャンネルポイントを交換して出題させた人の名前）を、合成ページが読む。形が違えば黙って流さずに投げる。
 */
import { describe, expect, it } from 'vitest'
import { parseKanjiQuizCall } from './call'

const call = {
  id: '出題ID',
  problem: { word: '境内', readings: ['けいだい'], grade: '6', explanation: '神社や寺の敷地の中。' },
  requesterName: '田中太郎',
}

describe('parseKanjiQuizCall', () => {
  it('識別子と問題1問と、出題させた人の名前を読む', () => {
    expect(parseKanjiQuizCall(JSON.stringify(call))).toEqual(call)
  })

  it('試し再生の出題は、出題させた人を持たない（null）', () => {
    const demo = { ...call, requesterName: null }

    expect(parseKanjiQuizCall(JSON.stringify(demo))).toEqual(demo)
  })

  it('JSONとして読めなければ投げる', () => {
    expect(() => parseKanjiQuizCall('{')).toThrowError(/JSON/)
  })

  it('識別子が無い・問題の形が違う（知らない級など）なら投げる', () => {
    expect(() => parseKanjiQuizCall(JSON.stringify({ problem: call.problem, requesterName: null }))).toThrowError(/形/)
    expect(() => parseKanjiQuizCall(JSON.stringify({ ...call, requesterName: 42 }))).toThrowError(/形/)
    expect(() => parseKanjiQuizCall(JSON.stringify({ ...call, problem: { ...call.problem, grade: '11' } }))).toThrowError(/級/)
  })
})
