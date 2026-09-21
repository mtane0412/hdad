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
      sentAt: undefined,
      firstMessage: false,
      returningChatter: false,
      subscriberMonths: 0,
      bits: 0,
      reply: undefined,
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

  it('バッジを「種類」と「版」の組として、Twitchが並べた順のまま取り出す（版ごとに公式の絵が違うため）', () => {
    const message = toChatMessage(書き込み('どうも', { badges: 'broadcaster/1,subscriber/12,premium/1' }))
    expect(message.badges).toEqual([
      { setId: 'broadcaster', versionId: '1' },
      { setId: 'subscriber', versionId: '12' },
      { setId: 'premium', versionId: '1' },
    ])
  })

  it('バッジが1つも付いていなければ、空にする', () => {
    expect(toChatMessage(書き込み('どうも', { badges: '' })).badges).toEqual([])
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

describe('toChatMessage（Twitchが送ってくる付帯情報）', () => {
  it('書き込まれた時刻（tmi-sent-ts）をミリ秒の数値として取り出す', () => {
    // 2026-09-21T12:34:56.000Z のミリ秒表現
    const message = toChatMessage(書き込み('こんばんは', { 'tmi-sent-ts': '1790080496000' }))
    expect(message.sentAt).toBe(1790080496000)
  })

  it('時刻のタグが無い場合は undefined にする（デモ用の書き込みなど、時刻が付かない経路があるため）', () => {
    expect(toChatMessage(書き込み('こんばんは')).sentAt).toBeUndefined()
  })

  it('このチャンネルで初めての書き込み（first-msg）を見分ける', () => {
    expect(toChatMessage(書き込み('はじめまして', { 'first-msg': '1' })).firstMessage).toBe(true)
    expect(toChatMessage(書き込み('またきました', { 'first-msg': '0' })).firstMessage).toBe(false)
    expect(toChatMessage(書き込み('ふつうの書き込み')).firstMessage).toBe(false)
  })

  it('久しぶりに戻ってきた視聴者（returning-chatter）を見分ける', () => {
    expect(toChatMessage(書き込み('おひさしぶり', { 'returning-chatter': '1' })).returningChatter).toBe(true)
    expect(toChatMessage(書き込み('ふつうの書き込み')).returningChatter).toBe(false)
  })

  it('サブスクの継続月数（badge-info の subscriber）を取り出す', () => {
    const message = toChatMessage(
      書き込み('24ヶ月めです', { badges: 'subscriber/12', 'badge-info': 'subscriber/24' }),
    )
    expect(message.subscriberMonths).toBe(24)
  })

  it('サブスクしていない視聴者の継続月数は 0 にする', () => {
    expect(toChatMessage(書き込み('こんにちは')).subscriberMonths).toBe(0)
  })

  it('Cheer のビッツ数（bits）を取り出す。Cheer でなければ 0 にする', () => {
    expect(toChatMessage(書き込み('cheer100 おうえんしてます', { bits: '100' })).bits).toBe(100)
    expect(toChatMessage(書き込み('ふつうの書き込み')).bits).toBe(0)
  })

  it('返信（reply-parent-*）なら、返信元の表示名と本文を取り出す', () => {
    const message = toChatMessage(
      書き込み('@はなこ そうですね', {
        'reply-parent-display-name': 'はなこ',
        'reply-parent-msg-body': 'きょうは暑いですね',
        'reply-parent-msg-id': 'メッセージID-0',
      }),
    )
    expect(message.reply).toEqual({
      displayName: 'はなこ',
      body: 'きょうは暑いですね',
      messageId: 'メッセージID-0',
    })
  })

  it('返信のとき、本文の先頭に付く「@返信先 」を落とす（返信元は引用行に出すため重複させない）', () => {
    const message = toChatMessage(
      書き込み('@はなこ そうですね', {
        'reply-parent-display-name': 'はなこ',
        'reply-parent-msg-body': 'きょうは暑いですね',
        'reply-parent-msg-id': 'メッセージID-0',
      }),
    )
    expect(message.fragments).toEqual([{ type: 'text', text: 'そうですね' }])
  })

  it('返信でなければ reply は undefined にする', () => {
    expect(toChatMessage(書き込み('ふつうの書き込み')).reply).toBeUndefined()
  })
})

describe('readableTextColor', () => {
  it('暗い色の上には白、明るい色の上には黒に近い色を返す', () => {
    expect(readableTextColor('#0000ff')).toBe('#ffffff')
    expect(readableTextColor('#ffff00')).toBe('#1a1a1a')
  })
})
