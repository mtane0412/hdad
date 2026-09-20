/**
 * IRCメッセージ解析（irc.ts）のテスト
 *
 * TwitchのチャットはIRCの1行（タグ・送信元・コマンド・引数）として届く。
 * 後段がタグや本文を取り出せるよう、1行を正しく分解できることを確認する。
 */
import { describe, expect, it } from 'vitest'
import { parseIrcLine } from './irc'

describe('parseIrcLine', () => {
  it('タグ・送信元・コマンド・引数に分解する', () => {
    const line =
      '@display-name=たねのぶ;color=#FF69B4 :tanenob!tanenob@tanenob.tmi.twitch.tv PRIVMSG #tanenob_ch :こんにちは 世界'
    expect(parseIrcLine(line)).toEqual({
      tags: { 'display-name': 'たねのぶ', color: '#FF69B4' },
      prefix: 'tanenob!tanenob@tanenob.tmi.twitch.tv',
      command: 'PRIVMSG',
      params: ['#tanenob_ch', 'こんにちは 世界'],
    })
  })

  it('タグも送信元もない行（PING）を分解する', () => {
    expect(parseIrcLine('PING :tmi.twitch.tv')).toEqual({
      tags: {},
      prefix: '',
      command: 'PING',
      params: ['tmi.twitch.tv'],
    })
  })

  it('本文（: 以降）のない行は、空白区切りの引数だけになる', () => {
    expect(parseIrcLine(':tmi.twitch.tv CLEARCHAT #tanenob_ch').params).toEqual(['#tanenob_ch'])
  })

  it('タグの値のエスケープ（\\s は空白、\\: はセミコロン、\\\\ は円記号）を元に戻す', () => {
    const line = '@system-msg=5ヶ月\\s継続\\:ありがとう\\\\ :tmi.twitch.tv USERNOTICE #tanenob_ch'
    expect(parseIrcLine(line).tags['system-msg']).toBe('5ヶ月 継続;ありがとう\\')
  })

  it('値のないタグは空文字になる', () => {
    expect(parseIrcLine('@color=;emotes= :tmi.twitch.tv PRIVMSG #a :b').tags).toEqual({ color: '', emotes: '' })
  })

  it('コマンドのない行はエラーにする', () => {
    expect(() => parseIrcLine('@color=#fff')).toThrow('IRCメッセージとして読めません')
  })
})
