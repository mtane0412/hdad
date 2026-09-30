/**
 * 読み上げ文の組み立て（text.ts）のテスト
 *
 * 確かめること:
 * - 読まないもの（コマンド・エモートだけの発言・読み上げない人）を除くこと
 * - 読む文（エモートの除去・URLの置き換え・連打の圧縮・長さの上限・名前の付け方）が整うこと
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../chat/message'
import { speechTextOf, type SpeechTextOptions } from './text'

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

const defaultConfig: SpeechTextOptions = { readName: false, maxLength: 60, ignoreLogins: [] }

/** 本文を文字の断片1つだけで組み立てて、読み上げ文にする */
const speechText = (text: string, config: Partial<SpeechTextOptions> = {}): string | null =>
  speechTextOf(writes({ fragments: [{ type: 'text', text }] }), { ...defaultConfig, ...config })

describe('speechTextOf（読まないもの）', () => {
  it('コマンド（!で始まる発言）は読まない', () => {
    expect(speechText('!hdad こんにちは')).toBeNull()
  })

  it('エモートだけの発言は読まない', () => {
    const message = writes({ fragments: [{ type: 'emote', name: 'Kappa', url: 'https://example.com/kappa.png' }] })

    expect(speechTextOf(message, defaultConfig)).toBeNull()
  })

  it('URLだけの発言も、置き換えた語が残るので読む', () => {
    expect(speechText('https://example.com/watch')).toBe('URL')
  })

  it('読み上げない人（botなど）の発言は読まない。ログイン名の大文字小文字は区別しない', () => {
    const message = writes({ login: 'hdad_bot' })

    expect(speechTextOf(message, { ...defaultConfig, ignoreLogins: ['HDAD_Bot'] })).toBeNull()
  })

  it('読み上げない人に挙がっていなければ読む', () => {
    const message = writes({ login: 'tanenob' })

    expect(speechTextOf(message, { ...defaultConfig, ignoreLogins: ['hdad_bot'] })).toBe('こんにちは')
  })

  it('文字が空白だけの発言は読まない', () => {
    expect(speechText('   ')).toBeNull()
  })
})

describe('speechTextOf（読む文の整え方）', () => {
  it('エモートとCheermoteを除き、文字の断片だけをつなげる', () => {
    const message = writes({
      fragments: [
        { type: 'text', text: 'すごい ' },
        { type: 'emote', name: 'PogChamp', url: 'https://example.com/pog.png' },
        { type: 'text', text: ' ですね ' },
        { type: 'cheer', name: 'cheer100', url: 'https://example.com/cheer.png', amount: 100, color: '#9c3ee8' },
      ],
    })

    expect(speechTextOf(message, defaultConfig)).toBe('すごい ですね')
  })

  it('URLは「URL」に置き換える（読み上げても意味が分からないため）', () => {
    expect(speechText('これ見て https://example.com/watch?v=1 おすすめ')).toBe('これ見て URL おすすめ')
  })

  it('URLの直後に空白なしで本文が続いても、本文を巻き込まない', () => {
    expect(speechText('見てhttps://example.com/xyz面白いよ')).toBe('見てURL面白いよ')
  })

  it('連続する空白は1つに詰める', () => {
    expect(speechText('こんにちは　　　みなさん')).toBe('こんにちは みなさん')
  })

  it('同じ文字の3回以上の連打は2回に縮める（wの連打をそのまま読ませない）', () => {
    expect(speechText('おもしろいwwwwww')).toBe('おもしろいww')
    expect(speechText('えーーーーっ！！！！')).toBe('えーーっ！！')
  })

  it('上限を超える本文は、上限の長さで切り詰める', () => {
    expect(speechText('あいうえお'.repeat(16), { maxLength: 10 })).toBe('あいうえおあいうえお')
  })

  it('名前を読む設定なら、本文の前に表示名を付ける', () => {
    expect(speechText('こんにちは', { readName: true })).toBe('たねのぶ、こんにちは')
  })

  it('名前は本文の長さの上限に数えない（本文が切り詰められても名前は残る）', () => {
    expect(speechText('あいうえお'.repeat(16), { readName: true, maxLength: 5 })).toBe('たねのぶ、あいうえお')
  })
})
