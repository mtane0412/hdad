// @vitest-environment jsdom
/**
 * 注目コメントの表示（view.ts）のテスト
 *
 * 配信画面に出しっぱなしにするものなので、見た目はCSSが決め、ここでは要素・クラス・属性だけを確かめる。
 * 特に重要なのは次の3点。
 * - 名前と本文を別々の要素として出すこと（CSSがそれぞれの大きさを決められるようにするため）
 * - 同じ1件を渡し直したときに要素を作り直さないこと（30秒ごとに読み直すので、作り直すと
 *   出現のアニメーションが繰り返し走ってしまう）
 * - 映すものが無くなったら何も残さないこと（消された発言を配信画面に残さない）
 */
import { describe, expect, it } from 'vitest'
import { createFocusView } from './view'
import type { FocusedMessage } from './focused'

/** 映す1件。文字だけの本文 */
const 映す1件 = (上書き: Partial<FocusedMessage> = {}): FocusedMessage => ({
  messageId: '発言1',
  login: 'kowai_hanashi',
  displayName: '怖い話す人',
  fragments: [{ type: 'text', text: '今から怖い話をするね' }],
  ...上書き,
})

/** 表示を作る。root と、そこに映す操作を返す */
const 用意する = () => {
  const root = document.createElement('div')
  document.body.replaceChildren(root)
  return { root, view: createFocusView(root) }
}

describe('createFocusView', () => {
  it('名前と本文を別々の要素として出す', () => {
    const { root, view } = 用意する()

    view.setFocused(映す1件())

    expect(root.querySelector('.focus-name')?.textContent).toBe('怖い話す人')
    expect(root.querySelector('.focus-body')?.textContent).toBe('今から怖い話をするね')
  })

  it('エモートは画像として出し、代替文字にエモート名を入れる（読み上げや確認のため）', () => {
    const { root, view } = 用意する()

    view.setFocused(
      映す1件({
        fragments: [
          { type: 'text', text: 'こわい ' },
          { type: 'emote', name: 'monkaS', url: 'https://example.com/monkaS.png' },
        ],
      }),
    )

    const image = root.querySelector<HTMLImageElement>('.focus-body img')
    expect(image?.getAttribute('src')).toBe('https://example.com/monkaS.png')
    expect(image?.alt).toBe('monkaS')
  })

  it('Cheermote は絵とビッツ数の両方を出す', () => {
    const { root, view } = 用意する()

    view.setFocused(
      映す1件({
        fragments: [{ type: 'cheer', name: 'cheer500', url: 'https://example.com/cheer.gif', amount: 500, color: '#1db2f5' }],
      }),
    )

    expect(root.querySelector<HTMLImageElement>('.focus-body img')?.alt).toBe('cheer500')
    expect(root.querySelector('.focus-body')?.textContent).toContain('500')
  })

  it('映すものが無ければ何も残さない（消された発言を配信画面に残さない）', () => {
    const { root, view } = 用意する()
    view.setFocused(映す1件())

    view.setFocused(null)

    expect(root.childElementCount).toBe(0)
  })

  it('同じ1件を渡し直したときは要素を作り直さない（出現のアニメーションを繰り返さないため）', () => {
    const { root, view } = 用意する()
    view.setFocused(映す1件())
    const 最初の本文 = root.querySelector('.focus-body')

    view.setFocused(映す1件())

    expect(root.querySelector('.focus-body')).toBe(最初の本文)
  })

  it('別の1件に変わったら要素を作り直す', () => {
    const { root, view } = 用意する()
    view.setFocused(映す1件())
    const 最初の本文 = root.querySelector('.focus-body')

    view.setFocused(映す1件({ messageId: '発言2', fragments: [{ type: 'text', text: 'それは去年の夏のことでした' }] }))

    expect(root.querySelector('.focus-body')).not.toBe(最初の本文)
    expect(root.querySelector('.focus-body')?.textContent).toBe('それは去年の夏のことでした')
  })

  it('本文の長さに応じて、字の大きさの区分を本文の要素に入れる（長い語りを配信画面からあふれさせないため）', () => {
    const { root, view } = 用意する()

    view.setFocused(映す1件({ fragments: [{ type: 'text', text: 'こわい' }] }))
    expect(root.querySelector<HTMLElement>('.focus-body')?.dataset.length).toBe('short')

    view.setFocused(映す1件({ messageId: '発言2', fragments: [{ type: 'text', text: 'あ'.repeat(80) }] }))
    expect(root.querySelector<HTMLElement>('.focus-body')?.dataset.length).toBe('medium')

    view.setFocused(映す1件({ messageId: '発言3', fragments: [{ type: 'text', text: 'あ'.repeat(200) }] }))
    expect(root.querySelector<HTMLElement>('.focus-body')?.dataset.length).toBe('long')
  })

  it('エモートも1文字として数える（絵ばかりの発言を小さくしすぎないため）', () => {
    const { root, view } = 用意する()

    view.setFocused(映す1件({ fragments: [{ type: 'emote', name: 'monkaS', url: 'https://example.com/monkaS.png' }] }))

    expect(root.querySelector<HTMLElement>('.focus-body')?.dataset.length).toBe('short')
  })

  it('本文が空なら投げる（名前だけのコメントを配信画面に出さない）', () => {
    const { view } = 用意する()

    expect(() => view.setFocused(映す1件({ fragments: [] }))).toThrow(/本文/)
  })
})
