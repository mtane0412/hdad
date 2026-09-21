// @vitest-environment jsdom
/**
 * チャット欄の表示（view.ts）のテスト
 *
 * message.ts が取り出した付帯情報（返信元・時刻・初回・継続月数・ビッツ）が、
 * 全デザイン共通のHTML構造として正しく組み立てられることを確認する。
 * 見た目はデザインごとのCSSが決めるため、ここでは要素・クラス・属性だけを確かめる。
 *
 * 注意: jsdom には Element.animate と実際のレイアウトが無いため、それらは差し替える。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from './message'
import { createChatView, type ChatViewOptions } from './view'

/** 前提: 視聴者「たねのぶ」の、付帯情報が何も付いていない書き込み */
const 書き込み = (上書き: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'メッセージID-1',
  login: 'tanenob',
  displayName: 'たねのぶ',
  color: '#ff69b4',
  badges: [],
  fragments: [{ type: 'text', text: 'こんにちは' }],
  action: false,
  sentAt: undefined,
  firstMessage: false,
  returningChatter: false,
  subscriberMonths: 0,
  bits: 0,
  reply: undefined,
  ...上書き,
})

const 既定の設定: ChatViewOptions = { max: 15, lifetime: 0, badges: true, timestamps: false }

/** チャット欄を作り、書き込みを1件入れて、その li 要素を返す */
const 表示する = (message: ChatMessage, 設定: Partial<ChatViewOptions> = {}): HTMLElement => {
  const root = document.createElement('ol')
  document.body.replaceChildren(root)
  createChatView(root, { ...既定の設定, ...設定 }).add(message)
  const item = root.querySelector<HTMLElement>('li')
  if (item === null) throw new Error('書き込みの要素が作られませんでした')
  return item
}

beforeEach(() => {
  // jsdom には Web Animations API が無いため、呼ばれても何もしない差し替えを入れる
  Element.prototype.animate = vi.fn(() => ({}) as Animation)
})

describe('createChatView（名札）', () => {
  it('表示名には chat-name-text を付ける（各デザインのCSSが、目印や月数と区別して名前だけを省略表示するため）', () => {
    const item = 表示する(書き込み({ firstMessage: true }))
    expect(item.querySelector('.chat-name > .chat-name-text')?.textContent).toBe('たねのぶ')
  })
})

describe('createChatView（返信元の引用）', () => {
  it('返信なら、名札の前に返信元の名前と本文を出す', () => {
    const item = 表示する(
      書き込み({ reply: { displayName: 'はなこ', body: 'きょうは暑いですね', messageId: 'メッセージID-0' } }),
    )
    const reply = item.querySelector('.chat-reply')
    expect(reply?.textContent).toBe('はなこ: きょうは暑いですね')
    // 返信元は名札より前に置く（読む順に合わせる）
    expect(reply?.nextElementSibling?.className).toBe('chat-name')
  })

  it('返信でなければ、返信元の行を出さない', () => {
    expect(表示する(書き込み()).querySelector('.chat-reply')).toBeNull()
  })
})

describe('createChatView（書き込まれた時刻）', () => {
  // 2026年9月21日 12時34分（実行環境のタイムゾーン）
  const 時刻 = new Date(2026, 8, 21, 12, 34).getTime()

  it('timestamps が true なら、時分を出し、datetime 属性に機械可読な時刻を入れる', () => {
    const time = 表示する(書き込み({ sentAt: 時刻 }), { timestamps: true }).querySelector('time.chat-time')
    expect(time?.textContent).toBe('12:34')
    expect(time?.getAttribute('datetime')).toBe(new Date(時刻).toISOString())
  })

  it('timestamps が false なら、時刻を出さない', () => {
    expect(表示する(書き込み({ sentAt: 時刻 })).querySelector('.chat-time')).toBeNull()
  })

  it('timestamps が true でも、時刻が届いていない書き込みには時刻を出さない', () => {
    expect(表示する(書き込み({ sentAt: undefined }), { timestamps: true }).querySelector('.chat-time')).toBeNull()
  })
})

describe('createChatView（初回・久しぶりの視聴者）', () => {
  it('このチャンネルで初めての書き込みなら、目印を出して is-first を付ける', () => {
    const item = 表示する(書き込み({ firstMessage: true }))
    expect(item.classList.contains('is-first')).toBe(true)
    expect(item.querySelector('.chat-flag')?.textContent).toBe('初見')
  })

  it('久しぶりに戻ってきた視聴者なら、目印を出して is-returning を付ける', () => {
    const item = 表示する(書き込み({ returningChatter: true }))
    expect(item.classList.contains('is-returning')).toBe(true)
    expect(item.querySelector('.chat-flag')?.textContent).toBe('おかえり')
  })

  it('初回でも久しぶりでもなければ、目印を出さない', () => {
    const item = 表示する(書き込み())
    expect(item.querySelector('.chat-flag')).toBeNull()
    expect(item.className).toBe('chat-message')
  })
})

describe('createChatView（サブスクの継続月数）', () => {
  it('バッジを表示する設定なら、サブスクバッジの後ろに継続月数を出す', () => {
    const item = 表示する(書き込み({ badges: ['subscriber'], subscriberMonths: 24 }))
    const months = item.querySelector('.chat-months')
    expect(months?.textContent).toBe('24')
    expect(months?.getAttribute('title')).toBe('サブスク24ヶ月')
  })

  it('バッジを表示しない設定なら、継続月数も出さない', () => {
    const item = 表示する(書き込み({ badges: ['subscriber'], subscriberMonths: 24 }), { badges: false })
    expect(item.querySelector('.chat-months')).toBeNull()
  })

  it('サブスクしていない視聴者には継続月数を出さない', () => {
    expect(表示する(書き込み()).querySelector('.chat-months')).toBeNull()
  })
})

describe('createChatView（Cheer のビッツ）', () => {
  it('ビッツが付いていれば、ビッツ数を出して is-cheer を付ける', () => {
    const item = 表示する(書き込み({ bits: 500 }))
    expect(item.classList.contains('is-cheer')).toBe(true)
    expect(item.querySelector('.chat-bits')?.textContent).toBe('500')
  })

  it('ビッツが付いていなければ、ビッツ数を出さない', () => {
    expect(表示する(書き込み()).querySelector('.chat-bits')).toBeNull()
  })
})

describe('createChatView（XSS対策）', () => {
  it('返信元の本文にHTMLが書かれていても、要素としては解釈しない', () => {
    const item = 表示する(
      書き込み({
        reply: { displayName: 'いたずら', body: '<img src=x onerror=alert(1)>', messageId: 'メッセージID-0' },
      }),
    )
    expect(item.querySelector('.chat-reply img')).toBeNull()
    expect(item.querySelector('.chat-reply')?.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})
