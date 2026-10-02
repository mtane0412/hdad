// @vitest-environment jsdom
/**
 * 字幕の表示（view.ts）のテスト
 *
 * 合成ページは毎フレーム映す行を渡すので、次の3点を確かめる。
 * - 映す行を上から順に、確定したかどうかの印を付けて出すこと
 * - 映す行が無ければ何も映さないこと（OBSでは透過の枠だけが残る）
 * - 同じ行を渡し直されたときにDOMを作り直さないこと（毎フレーム作り直すと重い）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createCaptionView } from './view'

let root: HTMLElement

beforeEach(() => {
  document.body.innerHTML = ''
  root = document.createElement('div')
  document.body.append(root)
})

describe('createCaptionView', () => {
  it('映す行を上から順に、確定したかどうかの印を付けて出す', () => {
    createCaptionView(root).render([
      { text: 'こんばんは', final: true },
      { text: '今日はゲームを', final: false },
    ])

    const lines = [...root.querySelectorAll<HTMLElement>('.caption-line')]
    expect(lines.map((line) => line.textContent)).toEqual(['こんばんは', '今日はゲームを'])
    expect(lines.map((line) => line.dataset.final)).toEqual(['true', 'false'])
  })

  it('映す行が無ければ何も映さない', () => {
    const view = createCaptionView(root)
    view.render([{ text: 'こんばんは', final: true }])
    view.render([])

    expect(root.querySelectorAll('.caption-line')).toHaveLength(0)
  })

  it('同じ行を渡し直されても、要素を作り直さない', () => {
    const view = createCaptionView(root)
    view.render([{ text: 'こんばんは', final: true }])
    const first = root.querySelector('.caption-line')
    view.render([{ text: 'こんばんは', final: true }])

    expect(root.querySelector('.caption-line')).toBe(first)
  })
})
