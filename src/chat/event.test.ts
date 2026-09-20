/**
 * チャットイベントへの変換（event.ts）のテスト
 *
 * IRCのコマンドのうち、チャット欄の表示に関わるものだけをイベントとして取り出せることを確認する。
 * モデレーターによる削除（CLEARCHAT / CLEARMSG）を配信画面にも反映できることが特に重要。
 */
import { describe, expect, it } from 'vitest'
import { toChatEvent } from './event'
import { parseIrcLine } from './irc'

const イベントにする = (line: string) => toChatEvent(parseIrcLine(line))

describe('toChatEvent', () => {
  it('PRIVMSG は書き込みイベントになる', () => {
    const event = イベントにする('@id=abc;display-name=たねのぶ :tanenob!tanenob@tanenob.tmi.twitch.tv PRIVMSG #ch :やあ')
    expect(event).toMatchObject({ type: 'message', message: { id: 'abc', displayName: 'たねのぶ' } })
  })

  it('対象ユーザー付きの CLEARCHAT（BAN・タイムアウト）は、そのユーザーの書き込みを消すイベントになる', () => {
    expect(イベントにする('@ban-duration=600 :tmi.twitch.tv CLEARCHAT #ch :arashi_user')).toEqual({
      type: 'clear-user',
      login: 'arashi_user',
    })
  })

  it('対象ユーザーなしの CLEARCHAT（/clear）は、全消去イベントになる', () => {
    expect(イベントにする(':tmi.twitch.tv CLEARCHAT #ch')).toEqual({ type: 'clear-all' })
  })

  it('CLEARMSG は、メッセージIDを指定した削除イベントになる', () => {
    expect(イベントにする('@login=arashi_user;target-msg-id=abc-123 :tmi.twitch.tv CLEARMSG #ch :けされる発言')).toEqual({
      type: 'delete',
      id: 'abc-123',
    })
  })

  it('ROOMSTATE は、チャンネルID（サードパーティエモートの取得に使う）を知らせるイベントになる', () => {
    expect(イベントにする('@emote-only=0;room-id=123456 :tmi.twitch.tv ROOMSTATE #ch')).toEqual({
      type: 'room',
      roomId: '123456',
    })
  })

  it('PING は、同じ内容で PONG を返すためのイベントになる', () => {
    expect(イベントにする('PING :tmi.twitch.tv')).toEqual({ type: 'ping', payload: 'tmi.twitch.tv' })
  })

  it('RECONNECT は再接続イベントになる', () => {
    expect(イベントにする(':tmi.twitch.tv RECONNECT')).toEqual({ type: 'reconnect' })
  })

  it('NOTICE（チャンネル停止中などTwitchからの通知）は、通知イベントになる', () => {
    expect(イベントにする('@msg-id=msg_channel_suspended :tmi.twitch.tv NOTICE #ch :This channel does not exist or has been suspended.')).toEqual({
      type: 'notice',
      text: 'This channel does not exist or has been suspended.',
    })
  })

  it('表示に関係しないコマンド（JOIN など）はイベントにならない', () => {
    expect(イベントにする(':justinfan1!justinfan1@justinfan1.tmi.twitch.tv JOIN #ch')).toBeUndefined()
  })
})
