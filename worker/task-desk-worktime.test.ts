/**
 * 作業した時間の合計（task-desk-worktime.ts）のテスト
 *
 * 作業机の宣言から、配信でみんなが作業した時間の合計と人数を出す計算と、差し込み語 {worktime} の文言を確かめる。
 */
import { describe, expect, it } from 'vitest'
import { fillWorkTime, MAX_WORK_TIME_TEXT_LENGTH, NO_WORK_TIME, sumWorkTime, workTimeText } from './task-desk-worktime'

const STARTED_AT = Date.parse('2026-10-03T12:00:00.000Z')
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
/** 配信が始まってから minutes 分後の時刻（ISO 8601） */
const at = (minutes: number): string => new Date(STARTED_AT + minutes * MINUTE).toISOString()
/** 配信が始まってから minutes 分後の時刻（ミリ秒） */
const msAt = (minutes: number): number => STARTED_AT + minutes * MINUTE

describe('sumWorkTime', () => {
  it('宣言から完了までの時間を足し込み、人数と作業中の人数を数える', () => {
    const rows = [
      // たなか: 10分〜40分（30分）で完了
      { declaredAt: at(10), doneAt: at(40), priorWorkMs: 0 },
      // すずき: 20分〜90分（70分）で完了
      { declaredAt: at(20), doneAt: at(90), priorWorkMs: 0 },
    ]

    expect(sumWorkTime(rows, msAt(120))).toEqual({ people: 2, totalMs: 100 * MINUTE, working: 0 })
  })

  it('完了していない宣言は、打ち切る時刻（配信中ならいま）までを数える', () => {
    const rows = [{ declaredAt: at(30), doneAt: null, priorWorkMs: 0 }]

    expect(sumWorkTime(rows, msAt(75))).toEqual({ people: 1, totalMs: 45 * MINUTE, working: 1 })
  })

  it('打ち直す前の宣言の時間（priorWorkMs）も合計に入る', () => {
    // やまだ: 前の宣言で25分作業し、60分に打ち直していまも作業中
    const rows = [{ declaredAt: at(60), doneAt: null, priorWorkMs: 25 * MINUTE }]

    expect(sumWorkTime(rows, msAt(70))).toEqual({ people: 1, totalMs: 35 * MINUTE, working: 1 })
  })

  it('打ち切る時刻より後の完了は、打ち切る時刻で数える（配信の終わりで打ち切る）', () => {
    const rows = [{ declaredAt: at(0), doneAt: at(200), priorWorkMs: 0 }]

    expect(sumWorkTime(rows, msAt(180))).toEqual({ people: 1, totalMs: 180 * MINUTE, working: 0 })
  })

  it('打ち切る時刻より後の宣言は、マイナスにせず0として数える', () => {
    const rows = [{ declaredAt: at(200), doneAt: null, priorWorkMs: 0 }]

    expect(sumWorkTime(rows, msAt(180))).toEqual({ people: 1, totalMs: 0, working: 1 })
  })

  it('宣言が1件も無ければ、0 ではなく null を返す（記録が無いのと0時間を見分けるため）', () => {
    expect(sumWorkTime([], msAt(60))).toBeNull()
  })
})

describe('workTimeText', () => {
  it('合計を「◯時間◯分（◯人）」で表す', () => {
    expect(workTimeText({ people: 5, totalMs: 14 * HOUR + 32 * MINUTE, working: 2 })).toBe('14時間32分（5人）')
  })

  it('1時間に満たなければ分だけで表し、端数の秒は切り捨てる', () => {
    expect(workTimeText({ people: 1, totalMs: 45 * MINUTE + 59 * 1000, working: 1 })).toBe('45分（1人）')
  })

  it('記録が無ければ、その旨の文言にする', () => {
    expect(workTimeText(null)).toBe(NO_WORK_TIME)
  })

  it('上限の長さを超える文になるときは投げる（保存の時点で見積もった長さを超えて送らないため）', () => {
    expect(() => workTimeText({ people: 10 ** 12, totalMs: 10 ** 18, working: 0 })).toThrow(`${MAX_WORK_TIME_TEXT_LENGTH}文字`)
  })
})

describe('fillWorkTime', () => {
  it('文言の {worktime} を合計に置き換える', () => {
    expect(fillWorkTime('今日はみんなで {worktime} 作業しました', { people: 3, totalMs: 2 * HOUR, working: 0 })).toBe(
      '今日はみんなで 2時間0分（3人） 作業しました',
    )
  })

  it('記録が無ければ、その旨の文言に置き換える', () => {
    expect(fillWorkTime('作業時間: {worktime}', null)).toBe(`作業時間: ${NO_WORK_TIME}`)
  })
})
