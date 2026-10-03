/**
 * 作業机の1行の形と、完了したばかりの見分け方（entry.ts）のテスト
 *
 * Worker から届く作業机を想定した形でなければ投げること（Fail-Fast）と、
 * 祝うのは「未完了だった宣言が完了した」ときだけであること（開き直したときや打ち直したときに祝い直さない）を確かめる。
 * 作業した時間の合計は、読み直さなくても作業中の人数ぶんだけ時間が進むことを確かめる（issue #209）。
 */
import { describe, expect, it } from 'vitest'
import { justCompleted, parseTaskDeskSnapshot, workTimeText, type TaskDeskEntry, type TaskDeskWorkTime } from './entry'

const working: TaskDeskEntry = { userId: '11111', name: 'たなか', task: '英単語を50個覚える', declaredAt: '2026-10-03T12:10:00.000Z', doneAt: null }
const done: TaskDeskEntry = { ...working, doneAt: '2026-10-03T12:40:00.000Z' }
/** 12:40 に読んだ合計。3人が合わせて1時間作業し、うち2人がいまも作業中 */
const workTime: TaskDeskWorkTime = { people: 3, totalMs: 60 * 60 * 1000, working: 2, measuredAt: '2026-10-03T12:40:00.000Z' }

describe('parseTaskDeskSnapshot', () => {
  it('押し出された作業机を、行の一覧と作業した時間の合計として読む', () => {
    expect(parseTaskDeskSnapshot(JSON.stringify({ entries: [working, done], workTime }))).toEqual({ entries: [working, done], workTime })
  })

  it('合計が null（配信していない・まだ誰も宣言していない）でも読む', () => {
    expect(parseTaskDeskSnapshot(JSON.stringify({ entries: [], workTime: null }))).toEqual({ entries: [], workTime: null })
  })

  it('合計の形が違えば投げる（合計が出なくなったことに気付けるように）', () => {
    expect(() => parseTaskDeskSnapshot(JSON.stringify({ entries: [], workTime: { people: 3 } }))).toThrow('workTime')
    expect(() => parseTaskDeskSnapshot(JSON.stringify({ entries: [] }))).toThrow('workTime')
  })

  it('JSONとして読めなければ投げる', () => {
    expect(() => parseTaskDeskSnapshot('作業机ではない文字列')).toThrow('JSON')
  })

  it('行の形が違えば投げる（完了の時刻が無い行を、未完了として黙って映さない）', () => {
    const withoutDoneAt = { userId: working.userId, name: working.name, task: working.task, declaredAt: working.declaredAt }
    expect(() => parseTaskDeskSnapshot(JSON.stringify({ entries: [withoutDoneAt], workTime: null }))).toThrow('entries')
  })
})

describe('justCompleted', () => {
  it('未完了だった宣言が完了したら true', () => {
    expect(justCompleted(working, done)).toBe(true)
  })

  it('前に映していなければ false（開いたときに、もう完了している人を祝わない）', () => {
    expect(justCompleted(undefined, done)).toBe(false)
  })

  it('前から完了していれば false', () => {
    expect(justCompleted(done, done)).toBe(false)
  })

  it('別の宣言に打ち直されていれば false（前の宣言の完了を、いまの宣言の完了と取り違えない）', () => {
    expect(justCompleted(working, { ...done, declaredAt: '2026-10-03T12:30:00.000Z' })).toBe(false)
  })
})

describe('workTimeText', () => {
  it('読んだ時刻の合計を「◯時間◯分（◯人）」で表す', () => {
    expect(workTimeText(workTime, Date.parse('2026-10-03T12:40:00.000Z'))).toBe('1時間0分（3人）')
  })

  it('読んでから経った時間を、作業中の人数ぶん足して進める', () => {
    // 10分経った: 作業中の2人ぶん20分が増える
    expect(workTimeText(workTime, Date.parse('2026-10-03T12:50:00.000Z'))).toBe('1時間20分（3人）')
  })

  it('いまが読んだ時刻より前（時計のずれ）でも、合計を減らさない', () => {
    expect(workTimeText(workTime, Date.parse('2026-10-03T12:30:00.000Z'))).toBe('1時間0分（3人）')
  })
})
