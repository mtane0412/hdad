// @vitest-environment jsdom
/**
 * サイドスーパーの表示（view.ts）のテスト
 *
 * 配信画面に出しっぱなしにするものなので、次の3点を確かめる。
 * - 行がひとつの白いボックス（.side-super-box）の中に入ること（バラエティ番組のテロップの形）
 * - 文言が無いあいだは何も映さないこと（OBSでは透過の枠だけが残るため）
 * - 同じ文言を読み直したときにDOMを作り直さないこと（作り直すと出現のアニメーションが5分おきに走る）
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
  it('行を1行ずつの要素にして、ひとつのボックスの中に出す', () => {
    createSideSuperView(root).setLines(['新作ゲーム', '初見プレイ中'])

    expect(root.querySelectorAll('.side-super-box')).toHaveLength(1)
    const box = root.querySelector('.side-super-box')
    expect([...(box?.querySelectorAll('.side-super-line') ?? [])].map((line) => line.textContent)).toEqual(['新作ゲーム', '初見プレイ中'])
  })

  it('文言が無いあいだは、ボックスごと何も映さない', () => {
    const view = createSideSuperView(root)
    view.setLines(['新作ゲーム'])
    view.setLines([])

    expect(root.querySelectorAll('.side-super-box')).toHaveLength(0)
    expect(root.querySelectorAll('.side-super-line')).toHaveLength(0)
  })

  it('同じ文言を読み直しても、ボックスと行の要素を作り直さない', () => {
    const view = createSideSuperView(root)
    view.setLines(['新作ゲーム', '初見プレイ中'])
    const 最初のボックス = root.querySelector('.side-super-box')
    const 最初の行 = root.querySelector('.side-super-line')

    view.setLines(['新作ゲーム', '初見プレイ中'])

    expect(root.querySelector('.side-super-box')).toBe(最初のボックス)
    expect(root.querySelector('.side-super-line')).toBe(最初の行)
  })

  it('文言が変わったら新しい行に差し替える', () => {
    const view = createSideSuperView(root)
    view.setLines(['新作ゲーム', '初見プレイ中'])

    view.setLines(['ボス戦に挑戦中'])

    expect([...root.querySelectorAll('.side-super-line')].map((line) => line.textContent)).toEqual(['ボス戦に挑戦中'])
  })
})
