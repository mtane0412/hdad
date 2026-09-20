/**
 * チャットメッセージへの変換（message.ts）のテスト
 *
 * IRCのタグから、表示に必要な情報（名前・色・バッジ・本文の断片）を取り出せることを確認する。
 * 特にエモートの位置は「文字数（コードポイント）」で届くため、絵文字や日本語が混ざってもずれないことを確かめる。
 */
import { describe, expect, it } from 'vitest'
import type { IrcMessage } from './irc'
import { readableTextColor, toChatMessage, twitchEmoteUrl } from './message'

/** 前提: 視聴者「たねのぶ」（ログイン名 tanenob）がチャンネル tanenob_ch に書き込んだ PRIVMSG */
const 書き込み = (本文: string, tags: Record<string, string> = {}): IrcMessage => ({
  tags: { id: 'メッセージID-1', 'display-name': 'たねのぶ', color: '#FF69B4', badges: '', emotes: '', ...tags },
  prefix: 'tanenob!tanenob@tanenob.tmi.twitch.tv',
  command: 'PRIVMSG',
  params: ['#tanenob_ch', 本文],
})

describe('toChatMessage', () => {
  it('名前・色・本文を取り出す', () => {
    expect(toChatMessage(書き込み('こんにちは'))).toEqual({
      id: 'メッセージID-1',
      login: 'tanenob',
      displayName: 'たねのぶ',
      color: '#ff69b4',
      badges: [],
      fragments: [{ type: 'text', text: 'こんにちは' }],
      action: false,
    })
  })

  it('表示名が空なら、ログイン名を表示名にする（Twitchの仕様で表示名を未設定のユーザーがいる）', () => {
    expect(toChatMessage(書き込み('やあ', { 'display-name': '' })).displayName).toBe('tanenob')
  })

  it('名前の色が未設定なら、ログイン名から決まる色を割り当てる（同じ人はいつも同じ色）', () => {
    const 一回目 = toChatMessage(書き込み('1', { color: '' })).color
    const 二回目 = toChatMessage(書き込み('2', { color: '' })).color
    expect(一回目).toMatch(/^#[0-9a-f]{6}$/)
    expect(二回目).toBe(一回目)
  })

  it('表示対象のバッジ（配信者・モデレーター・VIP・サブスク）だけを、届いた順によらず決まった順で取り出す', () => {
    const message = toChatMessage(書き込み('どうも', { badges: 'subscriber/12,premium/1,broadcaster/1' }))
    expect(message.badges).toEqual(['broadcaster', 'subscriber'])
  })

  it('エモートの位置指定に従って、本文を文字とエモートの断片に分ける', () => {
    // 「Kappa」(0〜4文字目) と 2つの「LUL」(11〜13, 15〜17文字目) を含む本文
    const message = toChatMessage(書き込み('Kappa わらった LUL LUL', { emotes: '25:0-4/425618:11-13,15-17' }))
    expect(message.fragments).toEqual([
      { type: 'emote', name: 'Kappa', url: twitchEmoteUrl('25') },
      { type: 'text', text: ' わらった ' },
      { type: 'emote', name: 'LUL', url: twitchEmoteUrl('425618') },
      { type: 'text', text: ' ' },
      { type: 'emote', name: 'LUL', url: twitchEmoteUrl('425618') },
    ])
  })

  it('絵文字（UTF-16で2単位になる文字）が前にあっても、エモートの位置がずれない', () => {
    // 「🎉」は1文字として数えられ、Kappa は 2〜6 文字目になる
    const message = toChatMessage(書き込み('🎉 Kappa', { emotes: '25:2-6' }))
    expect(message.fragments).toEqual([
      { type: 'text', text: '🎉 ' },
      { type: 'emote', name: 'Kappa', url: twitchEmoteUrl('25') },
    ])
  })

  it('/me の書き込みは、制御文字を外して action として扱う', () => {
    const message = toChatMessage(書き込み('\u0001ACTION おどっている\u0001'))
    expect(message.action).toBe(true)
    expect(message.fragments).toEqual([{ type: 'text', text: 'おどっている' }])
  })

  it('エモートの位置指定が読めない場合はエラーにする', () => {
    expect(() => toChatMessage(書き込み('Kappa', { emotes: '25:こわれた' }))).toThrow('emotes タグを読めません')
  })
})

describe('readableTextColor', () => {
  it('暗い色の上には白、明るい色の上には黒に近い色を返す', () => {
    expect(readableTextColor('#0000ff')).toBe('#ffffff')
    expect(readableTextColor('#ffff00')).toBe('#1a1a1a')
  })
})
