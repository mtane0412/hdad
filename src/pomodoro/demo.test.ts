/**
 * ポモドーロのサンプル（demo.ts）のテスト
 *
 * 管理画面のプレビューでは Worker につながないので、作業中・休憩中・一時停止中の札を順に見せる。
 * その3つがそろっていること（色分けと淡くした見た目をプレビューで確かめられる）と、
 * 映し始めた時刻から決まるタイマーになっていること（毎フレームの残り時間が進む）を確かめる。
 */
import { describe, expect, it } from 'vitest'
import { demoPomodoroScenes, demoTimerOf } from './demo'
import { phaseAt } from './phase'

const shownAt = Date.parse('2026-10-03T12:00:00Z')

describe('demoPomodoroScenes', () => {
  it('作業中・休憩中・一時停止中の場面がそろっている', () => {
    const timers = demoPomodoroScenes.map((scene) => demoTimerOf(scene, shownAt))

    expect(timers.some((timer) => timer.pausedAt === null && phaseAt(timer, shownAt).kind === 'work')).toBe(true)
    expect(timers.some((timer) => timer.pausedAt === null && phaseAt(timer, shownAt).kind === 'break')).toBe(true)
    expect(timers.some((timer) => timer.pausedAt !== null)).toBe(true)
  })

  it('動いている場面は、映し始めてからの時間だけ残り時間が減る', () => {
    const [working] = demoPomodoroScenes
    if (working === undefined) throw new Error('サンプルの場面がありません')
    const timer = demoTimerOf(working, shownAt)

    expect(phaseAt(timer, shownAt).remainingMs - phaseAt(timer, shownAt + 1000).remainingMs).toBe(1000)
  })
})
