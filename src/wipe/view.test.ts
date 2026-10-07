// @vitest-environment jsdom
/**
 * ワイプの表示（view.ts）のテスト
 *
 * 確かめること:
 * - アイコンの枠（ワイプ）と、名前・本文の吹き出しを組み立てること
 * - 本文のエモートは絵として出し、文字はそのまま出すこと（HTMLとして解釈しない）
 * - 引っ込めたら何も残さないこと
 */
import { describe, expect, it } from 'vitest'
import type { WipeComment } from './comment'
import { createWipeView } from './view'

const iconUrl = 'https://static-cdn.jtvnw.net/jtv_user_pictures/tanenob-profile_image-300x300.png'
const kappaUrl = 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0'

/** 前提: たねのぶさんが、エモートを添えて挨拶した */
const greeting: WipeComment = {
  messageId: 'メッセージID-1',
  login: 'tanenob',
  displayName: 'たねのぶ',
  fragments: [
    { type: 'text', text: 'こんにちは<b>' },
    { type: 'emote', name: 'Kappa', url: kappaUrl },
  ],
  spoken: 'こんにちは<b>',
}

describe('createWipeView', () => {
  it('アイコンの枠と、名前・本文の吹き出しを出す', () => {
    const root = document.createElement('div')
    const view = createWipeView(root)

    view.show({ comment: greeting, profileImageUrl: iconUrl })

    const icon = root.querySelector<HTMLImageElement>('.wipe-frame .wipe-icon')
    expect(icon?.src).toBe(iconUrl)
    // 名前は吹き出しに出ているので、アイコンの代替文字で繰り返さない
    expect(icon?.alt).toBe('')
    expect(root.querySelector('.wipe-bubble .wipe-name')?.textContent).toBe('たねのぶ')
  })

  it('本文の文字はHTMLとして解釈せず、エモートは名前を代替文字にした絵で出す', () => {
    const root = document.createElement('div')
    const view = createWipeView(root)

    view.show({ comment: greeting, profileImageUrl: iconUrl })

    const body = root.querySelector('.wipe-body')
    expect(body?.textContent).toBe('こんにちは<b>')
    expect(body?.querySelector('b')).toBeNull()
    const emote = body?.querySelector<HTMLImageElement>('img.wipe-emote')
    expect(emote?.src).toBe(kappaUrl)
    expect(emote?.alt).toBe('Kappa')
  })

  it('次の人を出したら、前の人の吹き出しは残さない', () => {
    const root = document.createElement('div')
    const view = createWipeView(root)

    view.show({ comment: greeting, profileImageUrl: iconUrl })
    view.show({ comment: { ...greeting, messageId: 'メッセージID-2', displayName: '怖い話す人' }, profileImageUrl: iconUrl })

    expect([...root.querySelectorAll('.wipe-name')].map((name) => name.textContent)).toEqual(['怖い話す人'])
  })

  it('引っ込めたら何も残さない', () => {
    const root = document.createElement('div')
    const view = createWipeView(root)

    view.show({ comment: greeting, profileImageUrl: iconUrl })
    view.hide()

    expect(root.childElementCount).toBe(0)
  })
})
