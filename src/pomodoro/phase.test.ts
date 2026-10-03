/**
 * ポモドーロの区間の計算（phase.ts）のテスト
 *
 * タイマーは「始めた時刻（一時停止のぶんだけずらした起点）」と「一時停止した時刻」だけを持ち、
 * いまが作業か休憩か・何本目か・残り何秒かは、現在時刻を渡してその都度計算する。
 * 合成ページ・アプリのページ・Worker のアラームが同じ計算を使うので、ここで区切りの前後と一時停止の扱いを確かめる。
 */
import { describe, expect, it } from 'vitest'
import {
  BREAK_MS,
  WORK_MS,
  formatRemaining,
  nextBoundaryAt,
  parsePomodoroSnapshot,
  pauseTimer,
  phaseAt,
  resumeTimer,
  startTimer,
  type PomodoroTimer,
} from './phase'

const MINUTE = 60 * 1000
const startedAt = Date.parse('2026-10-03T12:00:00Z')
const running: PomodoroTimer = startTimer(startedAt)

describe('定数', () => {
  it('作業は25分、休憩は5分', () => {
    expect(WORK_MS).toBe(25 * MINUTE)
    expect(BREAK_MS).toBe(5 * MINUTE)
  })
})

describe('phaseAt', () => {
  it('始めた直後は1本目の作業で、残りは25分', () => {
    expect(phaseAt(running, startedAt)).toEqual({ kind: 'work', round: 1, remainingMs: WORK_MS, durationMs: WORK_MS })
  })

  it('10分たったら、1本目の作業の残りは15分', () => {
    expect(phaseAt(running, startedAt + 10 * MINUTE)).toEqual({ kind: 'work', round: 1, remainingMs: 15 * MINUTE, durationMs: WORK_MS })
  })

  it('25分ちょうどで1本目の休憩に入る', () => {
    expect(phaseAt(running, startedAt + 25 * MINUTE)).toEqual({ kind: 'break', round: 1, remainingMs: BREAK_MS, durationMs: BREAK_MS })
  })

  it('30分ちょうどで2本目の作業に入る', () => {
    expect(phaseAt(running, startedAt + 30 * MINUTE)).toEqual({ kind: 'work', round: 2, remainingMs: WORK_MS, durationMs: WORK_MS })
  })

  it('何周しても同じように数える（3本目の休憩の途中）', () => {
    expect(phaseAt(running, startedAt + 2 * 30 * MINUTE + 27 * MINUTE)).toEqual({ kind: 'break', round: 3, remainingMs: 3 * MINUTE, durationMs: BREAK_MS })
  })

  it('一時停止しているあいだは、止めた時刻のまま進まない', () => {
    const paused = pauseTimer(running, startedAt + 10 * MINUTE)
    expect(phaseAt(paused, startedAt + 60 * MINUTE)).toEqual({ kind: 'work', round: 1, remainingMs: 15 * MINUTE, durationMs: WORK_MS })
  })

  it('再開すると、止めていた時間を飛ばして続きから進む', () => {
    const resumed = resumeTimer(pauseTimer(running, startedAt + 10 * MINUTE), startedAt + 40 * MINUTE)
    expect(phaseAt(resumed, startedAt + 45 * MINUTE)).toEqual({ kind: 'work', round: 1, remainingMs: 10 * MINUTE, durationMs: WORK_MS })
  })

  it('現在時刻が始めた時刻より前（合成ページの時計が遅れている）なら、始めた瞬間として扱う', () => {
    expect(phaseAt(running, startedAt - 2000)).toEqual({ kind: 'work', round: 1, remainingMs: WORK_MS, durationMs: WORK_MS })
  })
})

describe('pauseTimer・resumeTimer', () => {
  it('一時停止しても、始めた時刻（区切りの鍵の素）は変えない', () => {
    const resumed = resumeTimer(pauseTimer(running, startedAt + 10 * MINUTE), startedAt + 40 * MINUTE)
    expect(resumed.startedAt).toBe(startedAt)
    expect(resumed.pausedAt).toBeNull()
  })

  it('止めていないタイマーを再開しようとしたら投げる', () => {
    expect(() => resumeTimer(running, startedAt)).toThrow('一時停止')
  })

  it('もう止めているタイマーを一時停止しようとしたら投げる', () => {
    expect(() => pauseTimer(pauseTimer(running, startedAt), startedAt)).toThrow('一時停止')
  })
})

describe('nextBoundaryAt', () => {
  it('作業中なら、作業の終わる時刻', () => {
    expect(nextBoundaryAt(running, startedAt + 10 * MINUTE)).toBe(startedAt + 25 * MINUTE)
  })

  it('休憩中なら、休憩の終わる時刻', () => {
    expect(nextBoundaryAt(running, startedAt + 26 * MINUTE)).toBe(startedAt + 30 * MINUTE)
  })

  it('区切りちょうどなら、その次の区切り（同じ区切りへアラームを仕掛け直さない）', () => {
    expect(nextBoundaryAt(running, startedAt + 25 * MINUTE)).toBe(startedAt + 30 * MINUTE)
  })

  it('一時停止しているあいだは区切りが来ないので null', () => {
    expect(nextBoundaryAt(pauseTimer(running, startedAt + 10 * MINUTE), startedAt + 10 * MINUTE)).toBeNull()
  })
})

describe('formatRemaining', () => {
  it('分と秒を2桁で出す', () => {
    expect(formatRemaining(25 * MINUTE)).toBe('25:00')
    expect(formatRemaining(65 * 1000)).toBe('01:05')
  })

  it('1秒に満たない端数は切り上げる（0:00 になるのは区切りの瞬間だけにする）', () => {
    expect(formatRemaining(59 * 1000 + 1)).toBe('01:00')
    expect(formatRemaining(1)).toBe('00:01')
    expect(formatRemaining(0)).toBe('00:00')
  })
})

describe('parsePomodoroSnapshot', () => {
  it('動いているタイマーを読む', () => {
    expect(parsePomodoroSnapshot(JSON.stringify({ timer: running }))).toEqual(running)
  })

  it('止めているときは null', () => {
    expect(parsePomodoroSnapshot(JSON.stringify({ timer: null }))).toBeNull()
  })

  it('JSONとして読めなければ投げる', () => {
    expect(() => parsePomodoroSnapshot('タイマーではない文字列')).toThrow('JSON')
  })

  it('形が違えば投げる（一時停止の時刻が無いタイマーを、動いているものとして黙って映さない）', () => {
    expect(() => parsePomodoroSnapshot(JSON.stringify({ timer: { startedAt, anchorAt: startedAt } }))).toThrow('タイマー')
  })
})
