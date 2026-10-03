// @vitest-environment jsdom
/**
 * 作業机の表示（view.ts）のテスト
 *
 * 配信画面に出しっぱなしにするものなので、次の点を確かめる。
 * - 1人1行で、名前と作業を並べ、完了した行にはチェックの印が付くこと
 * - 祝うのは、映しているあいだに完了した行だけであること（開いたときに完了済みの人を祝わない）
 * - 変わっていない行の要素は作り直さないこと（作り直すと出現のアニメーションが全行で走る）
 * - 誰も宣言していないあいだも、参加のしかた（!task・!done）を出しておくこと
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { TaskDeskEntry } from './entry'
import { createTaskDeskView } from './view'

const tanakaWorking: TaskDeskEntry = { userId: '11111', name: 'たなか', task: '英単語を50個覚える', declaredAt: '2026-10-03T12:10:00.000Z', doneAt: null }
const tanakaDone: TaskDeskEntry = { ...tanakaWorking, doneAt: '2026-10-03T12:40:00.000Z' }
const suzukiWorking: TaskDeskEntry = { userId: '22222', name: 'すずき', task: '洗濯物をたたむ', declaredAt: '2026-10-03T12:20:00.000Z', doneAt: null }

let root: HTMLElement

beforeEach(() => {
  document.body.innerHTML = ''
  root = document.createElement('div')
  document.body.append(root)
})

const rows = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('.task-desk-entry')]

/** 映している行を「名前｜作業」の形で上から並べる */
const shownRows = (): string[] =>
  rows().map((row) => `${row.querySelector('.task-desk-name')?.textContent ?? ''}｜${row.querySelector('.task-desk-task')?.textContent ?? ''}`)

describe('createTaskDeskView', () => {
  it('渡された順に1人1行で、名前と作業を出す', () => {
    createTaskDeskView(root).setEntries([suzukiWorking, tanakaWorking])

    expect(shownRows()).toEqual(['すずき｜洗濯物をたたむ', 'たなか｜英単語を50個覚える'])
  })

  it('完了した行には印を付け、読み上げにも完了と伝える', () => {
    createTaskDeskView(root).setEntries([suzukiWorking, tanakaDone])

    expect(rows().map((row) => row.dataset.done)).toEqual([undefined, ''])
    expect(rows()[1]?.querySelector('.task-desk-check')?.getAttribute('aria-label')).toBe('完了')
    expect(rows()[0]?.querySelector('.task-desk-check')?.getAttribute('aria-label')).toBe('作業中')
  })

  it('映しているあいだに完了した行だけを祝う', () => {
    const view = createTaskDeskView(root)
    view.setEntries([suzukiWorking, tanakaWorking])

    view.setEntries([suzukiWorking, tanakaDone])

    expect(rows().map((row) => row.dataset.celebrate)).toEqual([undefined, ''])
  })

  it('開いたときにもう完了している行は祝わない', () => {
    createTaskDeskView(root).setEntries([tanakaDone])

    expect(rows()[0]?.dataset.celebrate).toBeUndefined()
  })

  it('変わっていない行の要素はそのまま使う', () => {
    const view = createTaskDeskView(root)
    view.setEntries([tanakaWorking])
    const shownTanaka = rows()[0]

    view.setEntries([suzukiWorking, tanakaWorking])

    expect(rows()[1]).toBe(shownTanaka)
  })

  it('誰も宣言していなくても、参加のしかたを出しておく', () => {
    createTaskDeskView(root).setEntries([])

    expect(rows()).toHaveLength(0)
    expect(root.querySelector('.task-desk-hint')?.textContent).toBe('!task 作業の内容 で宣言・!done で完了')
  })
})
