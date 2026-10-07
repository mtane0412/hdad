/**
 * ワイプに出す1件への変換（comment.ts）のテスト
 *
 * 確かめること:
 * - ワイプに出す発言は、読み上げる発言と同じもの（コマンド・エモートだけ・読み上げない人を除く）であること
 * - 吹き出しにはエモートの絵も含めた本文を出し、読み上げには整えた文を使うこと
 * - ミュート中に吹き出しを出しておく時間が、文の長さで伸び、上限で止まること
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../chat/message'
import type { SpeechTextOptions } from '../speech/text'
import { MAX_SILENT_DURATION_MS, MIN_SILENT_DURATION_MS, silentDurationOf, wipeCommentOf } from './comment'

/** 前提: 視聴者「たねのぶ」の、付帯情報が何も付いていない書き込み */
const writes = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
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
  ...overrides,
})

const speechOptions: SpeechTextOptions = { readName: false, maxLength: 60, ignoreLogins: ['nightbot'] }

describe('wipeCommentOf', () => {
  it('発言した人・本文の断片・読み上げ文をまとめる', () => {
    const kappa = { type: 'emote', name: 'Kappa', url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0' } as const
    const message = writes({ fragments: [{ type: 'text', text: 'おもしろいwwwww ' }, kappa] })

    expect(wipeCommentOf(message, speechOptions)).toEqual({
      messageId: 'メッセージID-1',
      login: 'tanenob',
      displayName: 'たねのぶ',
      // 吹き出しには絵も含めて、届いたとおりに出す
      fragments: [{ type: 'text', text: 'おもしろいwwwww ' }, kappa],
      // 読み上げは連打を縮め、絵を除いた文にする（src/speech/text.ts と同じ）
      spoken: 'おもしろいww',
    })
  })

  it('読み上げない人（bot）の発言はワイプにも出さない', () => {
    expect(wipeCommentOf(writes({ login: 'Nightbot' }), speechOptions)).toBeNull()
  })

  it('コマンドはワイプにも出さない', () => {
    expect(wipeCommentOf(writes({ fragments: [{ type: 'text', text: '!task 原稿を書く' }] }), speechOptions)).toBeNull()
  })

  it('エモートだけの発言はワイプにも出さない（読み上げる文が無く、吹き出しの長さを決められないため）', () => {
    const message = writes({ fragments: [{ type: 'emote', name: 'Kappa', url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0' }] })

    expect(wipeCommentOf(message, speechOptions)).toBeNull()
  })
})

describe('silentDurationOf', () => {
  it('短い発言でも、読み取れるだけの時間は出しておく', () => {
    expect(silentDurationOf('はい')).toBe(MIN_SILENT_DURATION_MS)
  })

  it('長い発言ほど長く出しておく', () => {
    expect(silentDurationOf('今日の配信はゲームの続きをやります。昨日は最後のボスの手前で終わったので')).toBeGreaterThan(
      silentDurationOf('今日の配信はゲームの続きをやります'),
    )
  })

  it('どれだけ長くても上限で止める（次の発言を待たせすぎないため）', () => {
    expect(silentDurationOf('あ'.repeat(500))).toBe(MAX_SILENT_DURATION_MS)
  })
})
