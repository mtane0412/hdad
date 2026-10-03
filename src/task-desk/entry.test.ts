/**
 * 作業机の1行の形と、完了したばかりの見分け方（entry.ts）のテスト
 *
 * Worker から届く作業机を想定した形でなければ投げること（Fail-Fast）と、
 * 祝うのは「未完了だった宣言が完了した」ときだけであること（開き直したときや打ち直したときに祝い直さない）を確かめる。
 */
import { describe, expect, it } from 'vitest'
import { justCompleted, parseTaskDeskSnapshot, type TaskDeskEntry } from './entry'

const working: TaskDeskEntry = { userId: '11111', name: 'たなか', task: '英単語を50個覚える', declaredAt: '2026-10-03T12:10:00.000Z', doneAt: null }
const done: TaskDeskEntry = { ...working, doneAt: '2026-10-03T12:40:00.000Z' }

describe('parseTaskDeskSnapshot', () => {
  it('押し出された作業机を、行の一覧として読む', () => {
    expect(parseTaskDeskSnapshot(JSON.stringify({ entries: [working, done] }))).toEqual([working, done])
  })

  it('JSONとして読めなければ投げる', () => {
    expect(() => parseTaskDeskSnapshot('作業机ではない文字列')).toThrow('JSON')
  })

  it('行の形が違えば投げる（完了の時刻が無い行を、未完了として黙って映さない）', () => {
    const withoutDoneAt = { userId: working.userId, name: working.name, task: working.task, declaredAt: working.declaredAt }
    expect(() => parseTaskDeskSnapshot(JSON.stringify({ entries: [withoutDoneAt] }))).toThrow('entries')
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
