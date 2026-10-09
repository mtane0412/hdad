// @vitest-environment jsdom
/**
 * テキストの表示（view.ts）のテスト
 *
 * 配信画面に出しっぱなしにするものなので、次の点を確かめる。
 * - 名前を見出しに、本文をその下に出し、本文の改行はそのまま残すこと
 * - 本文が空のあいだは札ごと隠すこと（空の板を映さない）
 * - 中身が変わらなければ要素を作り直さないこと（読み直しのたびに出現のアニメーションが走らないように）
 * - 選んだ枠の種類とあふれの扱いを札に付けること（見た目は text.css が枠ごとに決める）
 * - 流す扱いでは、本文を1行にまとめて流す帯の中に入れること
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { TextEntry } from './entry'
import { createTextView } from './view'

const goal: TextEntry = { id: 1, name: '目標', body: 'ログイン画面を作り終える\nテストも書く', mode: 'manual', instruction: '', writtenBy: 'human', updatedAt: '2026-10-08T12:00:00.000Z' }

/** いまの見た目と同じ「板・固定」 */
const layout = { frame: 'board', overflow: 'clip' } as const

let root: HTMLElement

beforeEach(() => {
  document.body.innerHTML = ''
  root = document.createElement('div')
  document.body.append(root)
})

const board = (): HTMLElement | null => root.querySelector<HTMLElement>('.text-board')

describe('createTextView', () => {
  it('名前と本文を出し、本文の改行はそのまま残す', () => {
    createTextView(root, layout).show(goal)

    expect(board()?.querySelector('.text-board-name')?.textContent).toBe('目標')
    expect(board()?.querySelector('.text-board-body')?.textContent).toBe('ログイン画面を作り終える\nテストも書く')
    expect(board()?.hidden).toBe(false)
  })

  it('本文が空なら札を隠す', () => {
    createTextView(root, layout).show({ ...goal, body: '' })

    expect(board()?.hidden).toBe(true)
  })

  it('本文が書き換わったら、新しい本文に差し替える', () => {
    const view = createTextView(root, layout)
    view.show(goal)

    view.show({ ...goal, body: 'ログイン画面をデプロイする', mode: 'manual', instruction: '', writtenBy: 'human', updatedAt: '2026-10-08T12:30:00.000Z' })

    expect(board()?.querySelector('.text-board-body')?.textContent).toBe('ログイン画面をデプロイする')
  })

  it('名前も本文も変わらなければ、要素を作り直さない', () => {
    const view = createTextView(root, layout)
    view.show(goal)
    const before = board()

    view.show({ ...goal })

    expect(board()).toBe(before)
  })

  it('選んだ枠の種類とあふれの扱いを札に付ける', () => {
    createTextView(root, { frame: 'window', overflow: 'shrink' }).show(goal)

    expect(board()?.classList.contains('text-board--window')).toBe(true)
    expect(board()?.dataset.overflow).toBe('shrink')
  })

  it('流す扱いでは、本文を1行にまとめて流す帯に入れる', () => {
    createTextView(root, { frame: 'telop', overflow: 'marquee' }).show(goal)

    const track = board()?.querySelector('.text-board-body .text-board-track')
    expect(track?.textContent).toBe('ログイン画面を作り終える　テストも書く')
  })
})
