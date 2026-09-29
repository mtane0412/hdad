// @vitest-environment jsdom
/**
 * 再生中の曲の表示（credit-view.ts）のテスト
 *
 * 配信画面に出しっぱなしにするものなので、次の3点を確かめる。
 * - 曲名（.bgm-credit-title）とクレジット表記（.bgm-credit-credit）を別々の要素に出すこと
 * - 曲を止めているあいだは何も映さないこと（止めているのは正常な状態で、OBSでは透過の枠だけが残るため）
 * - 同じ曲を受け取り直したときにDOMを作り直さないこと（つなぎ直すたびに出現のアニメーションが走らないため）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createBgmCreditView } from './credit-view'

/** 流している曲 */
const 雑談の曲 = { mediaId: 'media-zatsudan', title: 'ひだまりの午後', credit: '音楽: 甘茶の音楽工房' }

let root: HTMLElement

beforeEach(() => {
  document.body.innerHTML = ''
  root = document.createElement('div')
  document.body.append(root)
})

describe('createBgmCreditView', () => {
  it('曲名とクレジット表記を別々の要素に出す', () => {
    createBgmCreditView(root).setTrack(雑談の曲)

    expect(root.querySelector('.bgm-credit-title')?.textContent).toBe('ひだまりの午後')
    expect(root.querySelector('.bgm-credit-credit')?.textContent).toBe('音楽: 甘茶の音楽工房')
  })

  it('曲を止めたら、何も映さない', () => {
    const view = createBgmCreditView(root)
    view.setTrack(雑談の曲)
    view.setTrack(null)

    expect(root.childElementCount).toBe(0)
  })

  it('同じ曲を受け取り直しても、要素を作り直さない', () => {
    const view = createBgmCreditView(root)
    view.setTrack(雑談の曲)
    const 最初の曲名 = root.querySelector('.bgm-credit-title')
    view.setTrack({ ...雑談の曲 })

    expect(root.querySelector('.bgm-credit-title')).toBe(最初の曲名)
  })

  it('同じ曲でもクレジット表記を直したら、出し直す', () => {
    const view = createBgmCreditView(root)
    view.setTrack(雑談の曲)
    view.setTrack({ ...雑談の曲, credit: '音楽: 甘茶の音楽工房（甘茶）' })

    expect(root.querySelector('.bgm-credit-credit')?.textContent).toBe('音楽: 甘茶の音楽工房（甘茶）')
  })
})
