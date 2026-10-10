/**
 * 漢字クイズの呼び出し（call.ts）のテスト
 *
 * Worker（worker/kanji-quiz-issue.ts）が押し出す1回ぶんの出題（問題1問と、チャンネルポイントを交換して出題させた人の名前）を、合成ページが読む。
 * 同じ経路で、最初の正解者（type: answer）と出題できなかった理由（type: failure）も届く（issue #301）。
 * 時間切れで配信を止めるまでの猶予（type: stopping）と、停止の取り消し（type: stopCancelled）も届く（issue #302）。形が違えば黙って流さずに投げる。
 * 裏方のページへ届く、配信を止める命令（parseStreamStopOrder）もここで読む。
 */
import { describe, expect, it } from 'vitest'
import { parseKanjiQuizMessage, parseStreamStopOrder } from './call'

const call = {
  id: '出題ID',
  problem: { word: '境内', readings: ['けいだい'], grade: '6', explanation: '神社や寺の敷地の中。' },
  requesterName: '田中太郎',
  // 正解の音だけを選んだ音の設定（Worker が素材のIDを音声のURLに置き換えたもの）
  sound: {
    slots: { bgm: null, start: null, countdown: null, correct: '/api/media/media-pinpon?key=overlay-key', timeUp: null },
    bgmVolume: 0.3,
    effectVolume: 0.6,
  },
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

  it('音の設定が無い・枠が欠けている出題は、黙って無音で流さずに投げる', () => {
    const withoutSound = { id: call.id, problem: call.problem, requesterName: call.requesterName }
    // 時間切れ（timeUp）の枠を書き忘れた音の設定
    const { bgm, start, countdown, correct } = call.sound.slots
    const slotsWithoutTimeUp = { bgm, start, countdown, correct }

    expect(() => parseKanjiQuizMessage(JSON.stringify(withoutSound))).toThrowError(/音の設定/)
    expect(() => parseKanjiQuizMessage(JSON.stringify({ ...call, sound: { ...call.sound, slots: slotsWithoutTimeUp } }))).toThrowError(/timeUp/)
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

  it('配信を止めるまでの猶予は、出題の識別子・猶予の長さ・試し再生かを読む', () => {
    expect(parseKanjiQuizMessage(JSON.stringify({ type: 'stopping', quizId: '出題ID', graceMs: 10000, rehearsal: false }))).toEqual({
      type: 'stopping',
      quizId: '出題ID',
      graceMs: 10000,
      rehearsal: false,
    })
  })

  it('配信の停止の取り消しは、出題の識別子を読む', () => {
    expect(parseKanjiQuizMessage(JSON.stringify({ type: 'stopCancelled', quizId: '出題ID' }))).toEqual({ type: 'stopCancelled', quizId: '出題ID' })
  })

  it('猶予の長さが数でない・試し再生かが無い・取り消しの識別子が無いなら投げる', () => {
    expect(() => parseKanjiQuizMessage(JSON.stringify({ type: 'stopping', quizId: '出題ID', graceMs: '10秒', rehearsal: false }))).toThrowError(/猶予/)
    expect(() => parseKanjiQuizMessage(JSON.stringify({ type: 'stopping', quizId: '出題ID', graceMs: 10000 }))).toThrowError(/猶予/)
    expect(() => parseKanjiQuizMessage(JSON.stringify({ type: 'stopCancelled' }))).toThrowError(/取り消し/)
  })

  it('正解者の名前が無い・知らない type なら投げる', () => {
    expect(() => parseKanjiQuizMessage(JSON.stringify({ type: 'answer', quizId: '出題ID' }))).toThrowError(/正解者/)
    expect(() => parseKanjiQuizMessage(JSON.stringify({ type: 'failure' }))).toThrowError(/失敗/)
    expect(() => parseKanjiQuizMessage(JSON.stringify({ type: 'hint', quizId: '出題ID' }))).toThrowError(/hint/)
  })
})

describe('parseStreamStopOrder', () => {
  it('配信を止める命令から、出題の識別子を読む', () => {
    expect(parseStreamStopOrder(JSON.stringify({ quizId: '出題ID' }))).toEqual({ quizId: '出題ID' })
  })

  it('JSONとして読めない・出題の識別子が無いなら投げる', () => {
    expect(() => parseStreamStopOrder('{')).toThrowError(/JSON/)
    expect(() => parseStreamStopOrder(JSON.stringify({}))).toThrowError(/形/)
  })
})
