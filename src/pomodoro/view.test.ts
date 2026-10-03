// @vitest-environment jsdom
/**
 * ポモドーロの表示（view.ts）のテスト
 *
 * 合成ページの素材「ポモドーロ」は、タイマー（始めた時刻と一時停止の時刻）と現在時刻だけから毎フレーム描く。
 * 次の点を確かめる。
 * - 作業中か休憩中か・何本目か・残り時間を出し、区間の種類を data-phase に持つこと（見た目の色分けはCSSが決める）
 * - 一時停止しているあいだは止めた時刻のまま出し、data-paused を付けること
 * - 止めているときは何も映さないこと
 * - 同じ表示のまま描き直しても、文字の要素を書き換えないこと（毎フレーム呼ばれるため）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { pauseTimer, startTimer } from './phase'
import { createPomodoroView } from './view'

const MINUTE = 60 * 1000
const startedAt = Date.parse('2026-10-03T12:00:00Z')
const running = startTimer(startedAt)

let root: HTMLElement

beforeEach(() => {
  document.body.innerHTML = ''
  root = document.createElement('div')
  document.body.append(root)
})

const textOf = (selector: string): string | null => root.querySelector(selector)?.textContent ?? null

describe('createPomodoroView', () => {
  it('作業中は「作業中」・何本目か・残り時間を出す', () => {
    const view = createPomodoroView(root)

    view.render(running, startedAt + 10 * MINUTE)

    expect(root.hidden).toBe(false)
    expect(root.dataset.phase).toBe('work')
    expect(textOf('.pomodoro-phase')).toBe('作業中')
    expect(textOf('.pomodoro-round')).toBe('1本目')
    expect(textOf('.pomodoro-remaining')).toBe('15:00')
  })

  it('休憩中は「休憩中」を出し、data-phase を break にする', () => {
    const view = createPomodoroView(root)

    view.render(running, startedAt + 27 * MINUTE)

    expect(root.dataset.phase).toBe('break')
    expect(textOf('.pomodoro-phase')).toBe('休憩中')
    expect(textOf('.pomodoro-remaining')).toBe('03:00')
  })

  it('進み具合を、区間の長さに対する割合で棒に出す', () => {
    const view = createPomodoroView(root)

    view.render(running, startedAt + 5 * MINUTE)

    // 25分のうち5分たった
    expect(root.querySelector<HTMLElement>('.pomodoro-progress')?.style.getPropertyValue('--pomodoro-progress')).toBe('0.2')
  })

  it('一時停止しているあいだは、止めた時刻のまま「一時停止中」を出す', () => {
    const view = createPomodoroView(root)

    view.render(pauseTimer(running, startedAt + 10 * MINUTE), startedAt + 20 * MINUTE)

    expect(root.dataset.paused).toBe('')
    expect(textOf('.pomodoro-phase')).toBe('一時停止中')
    expect(textOf('.pomodoro-remaining')).toBe('15:00')
  })

  it('再開したら、一時停止の印を外す', () => {
    const view = createPomodoroView(root)
    view.render(pauseTimer(running, startedAt + 10 * MINUTE), startedAt + 20 * MINUTE)

    view.render(running, startedAt + 11 * MINUTE)

    expect(root.dataset.paused).toBeUndefined()
    expect(textOf('.pomodoro-phase')).toBe('作業中')
  })

  it('止めているときは何も映さない', () => {
    const view = createPomodoroView(root)
    view.render(running, startedAt)

    view.render(null, startedAt + MINUTE)

    expect(root.hidden).toBe(true)
  })

  it('表示が変わらなければ、文字の要素を書き換えない（毎フレーム呼ばれるため）', () => {
    const view = createPomodoroView(root)
    view.render(running, startedAt + 10 * MINUTE)
    const remaining = root.querySelector('.pomodoro-remaining')
    const textNode = remaining?.firstChild

    // 同じ秒のうちに描き直す
    view.render(running, startedAt + 10 * MINUTE + 100)

    expect(remaining?.firstChild).toBe(textNode)
  })
})
