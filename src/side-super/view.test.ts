// @vitest-environment jsdom
/**
 * サイドスーパーの表示（view.ts）のテスト
 *
 * 配信画面に出しっぱなしにするものなので、次の4点を確かめる。
 * - 見出し（.side-super-head）と本文（.side-super-body）が別々の要素になること
 *   （テレビのテロップは上下が別々の帯で、ひとつの箱にまとめると通知カードに見えるため）
 * - 文言が無いあいだは何も映さないこと（OBSでは透過の枠だけが残るため）
 * - 同じ文言を読み直したときにDOMを作り直さないこと（作り直すと出現のアニメーションが30秒おきに走る）
 * - 2行でも0行でもない行数を渡されたら投げること（Fail-Fast）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createSideSuperView } from './view'

let root: HTMLElement

beforeEach(() => {
  document.body.innerHTML = ''
  root = document.createElement('div')
  document.body.append(root)
})

describe('createSideSuperView', () => {
  it('1行目を見出し、2行目を本文として別々の要素に出す', () => {
    createSideSuperView(root).setLines(['初見プレイ中', 'ボス戦へ向けて装備集め'])

    expect(root.querySelector('.side-super-head')?.textContent).toBe('初見プレイ中')
    expect(root.querySelector('.side-super-body')?.textContent).toBe('ボス戦へ向けて装備集め')
  })

  it('文言が無いあいだは、見出しごと何も映さない', () => {
    const view = createSideSuperView(root)
    view.setLines(['初見プレイ中', 'ボス戦へ向けて装備集め'])
    view.setLines([])

    expect(root.querySelectorAll('.side-super-head')).toHaveLength(0)
    expect(root.querySelectorAll('.side-super-body')).toHaveLength(0)
  })

  it('同じ文言を読み直しても、行の要素を作り直さない', () => {
    const view = createSideSuperView(root)
    view.setLines(['初見プレイ中', 'ボス戦へ向けて装備集め'])
    const 最初の見出し = root.querySelector('.side-super-head')
    const 最初の本文 = root.querySelector('.side-super-body')

    view.setLines(['初見プレイ中', 'ボス戦へ向けて装備集め'])

    expect(root.querySelector('.side-super-head')).toBe(最初の見出し)
    expect(root.querySelector('.side-super-body')).toBe(最初の本文)
  })

  it('本文だけが変わったら、新しい文言に差し替える', () => {
    const view = createSideSuperView(root)
    view.setLines(['初見プレイ中', 'ボス戦へ向けて装備集め'])

    view.setLines(['初見プレイ中', 'ラスボスに挑戦中'])

    expect(root.querySelector('.side-super-head')?.textContent).toBe('初見プレイ中')
    expect(root.querySelector('.side-super-body')?.textContent).toBe('ラスボスに挑戦中')
  })

  it('2行でも0行でもない行数を渡されたら投げる（黙って1行だけ映さない）', () => {
    const view = createSideSuperView(root)

    expect(() => view.setLines(['見出しだけ'])).toThrow('2行')
  })
})
