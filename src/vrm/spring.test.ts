/**
 * 揺れ物（SpringBone）を進める時間（spring.ts）のテスト
 *
 * 確かめること:
 * - 前のコマからの時間差を秒にして返すこと
 * - 最初のコマ・時刻が戻ったときは揺れ物を進めないこと（0 秒）
 * - コマが落ちて時間差が大きくなっても、上限より大きくは進めないこと（遅れて追いつくだけにする）
 */
import { describe, expect, it } from 'vitest'
import { MAX_SPRING_STEP_SECONDS, springStepSeconds } from './spring'

/** 確かめる時刻の起点（配信中のある時刻。ミリ秒） */
const BASE_TIME = Date.parse('2026-10-13T21:00:00+09:00')

describe('springStepSeconds', () => {
  it('前のコマからの時間差を秒にして返す', () => {
    expect(springStepSeconds(BASE_TIME, BASE_TIME + 16)).toBeCloseTo(0.016, 6)
  })

  it('最初のコマ（前のコマが無い）では進めない', () => {
    expect(springStepSeconds(null, BASE_TIME)).toBe(0)
  })

  it('時刻が戻ったときは進めない（時計の合わせ直しなど）', () => {
    expect(springStepSeconds(BASE_TIME, BASE_TIME - 500)).toBe(0)
  })

  it('OBSでソースを隠していたあいだのように時間差が大きくても、上限より大きくは進めない', () => {
    expect(springStepSeconds(BASE_TIME, BASE_TIME + 60_000)).toBe(MAX_SPRING_STEP_SECONDS)
    expect(MAX_SPRING_STEP_SECONDS).toBeLessThanOrEqual(1 / 30)
  })
})
