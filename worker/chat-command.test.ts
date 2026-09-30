/**
 * チャットのコマンドの判定（chat-command.ts）のテスト
 *
 * 通知の中身を取り出す部分と、何を送り返すかを決める部分は通信を伴わないので、ここでまとめて確かめる。
 * 特に重要なのは、bot自身の発言に応答しないこと（応答するとbotがbotに応答し続けて止まらなくなる）。
 */
import { describe, expect, it } from 'vitest'
import { needsBgmCredit, needsStreamSummary, readChatMessage, resolveReply, type BotCommand, type ChatMessage } from './chat-command'

const botId = '67890'

const commandList: readonly BotCommand[] = [
  { name: 'ping', reply: '@{user} pong' },
  { name: 'discord', reply: 'Discordはこちらです: https://example.com/discord' },
]

const viewerMessage = (text: string): ChatMessage => ({
  broadcasterUserId: '12345',
  messageId: 'message-id-0123456789',
  chatterUserId: '11111',
  chatterUserLogin: 'shichousha',
  chatterUserName: '視聴者さん',
  text,
  badges: [],
})

describe('readChatMessage', () => {
  it('通知の event から、発言者とメッセージの本文を取り出す', () => {
    const event = {
      broadcaster_user_id: '12345',
      chatter_user_id: '11111',
      chatter_user_login: 'shichousha',
      chatter_user_name: '視聴者さん',
      message_id: 'message-id-0123456789',
      message: { text: '!ping', fragments: [{ type: 'text', text: '!ping' }] },
      badges: [],
    }

    expect(readChatMessage(event)).toEqual({
      broadcasterUserId: '12345',
      messageId: 'message-id-0123456789',
      chatterUserId: '11111',
      chatterUserLogin: 'shichousha',
      chatterUserName: '視聴者さん',
      text: '!ping',
      badges: [],
    })
  })

  it('通知のバッジを、種類の名前（set_id）の一覧として取り出す（自動モデレーションの対象外の判定に使う）', () => {
    const event = {
      broadcaster_user_id: '12345',
      chatter_user_id: '11111',
      chatter_user_login: 'moderator-san',
      chatter_user_name: 'モデレーターさん',
      message_id: 'message-id-0123456789',
      message: { text: 'こんばんは' },
      badges: [
        { set_id: 'moderator', id: '1', info: '' },
        { set_id: 'subscriber', id: '12', info: '12' },
      ],
    }

    expect(readChatMessage(event).badges).toEqual(['moderator', 'subscriber'])
  })

  it('バッジが無い通知は、バッジなしとして扱う（バッジは付いていないことのほうが多いため）', () => {
    const event = {
      broadcaster_user_id: '12345',
      chatter_user_id: '11111',
      chatter_user_login: 'shichousha',
      chatter_user_name: '視聴者さん',
      message_id: 'message-id-0123456789',
      message: { text: 'こんばんは' },
    }

    expect(readChatMessage(event).badges).toEqual([])
  })

  it('event が無ければエラーになる', () => {
    expect(() => readChatMessage(undefined)).toThrow()
  })

  it('本文（message.text）が無ければエラーになる', () => {
    const event = {
      broadcaster_user_id: '12345',
      chatter_user_id: '11111',
      chatter_user_login: 'shichousha',
      chatter_user_name: '視聴者さん',
      message_id: 'message-id-0123456789',
      message: {},
    }
    expect(() => readChatMessage(event)).toThrow()
  })

  it('発言者のIDが無ければエラーになる（bot自身の発言かを判別できないため）', () => {
    const event = {
      broadcaster_user_id: '12345',
      chatter_user_login: 'shichousha',
      chatter_user_name: '視聴者さん',
      message_id: 'message-id-0123456789',
      message: { text: '!ping' },
    }
    expect(() => readChatMessage(event)).toThrow()
  })

  it('発言者の表示名が無ければエラーになる（アラートの文言に差し込むため）', () => {
    const event = {
      broadcaster_user_id: '12345',
      chatter_user_id: '11111',
      chatter_user_login: 'shichousha',
      message_id: 'message-id-0123456789',
      message: { text: '!ping' },
    }
    expect(() => readChatMessage(event)).toThrow(/chatter_user_name/)
  })
})

describe('resolveReply', () => {
  it('コマンドに一致すれば、送り返す文言を返す', () => {
    expect(resolveReply(commandList, viewerMessage('!ping'), botId)).toBe('@shichousha pong')
  })

  it('差し込み語のない応答文は、そのまま返す', () => {
    expect(resolveReply(commandList, viewerMessage('!discord'), botId)).toBe('Discordはこちらです: https://example.com/discord')
  })

  it('コマンドの後ろに文字が続いていても、コマンドとして扱う', () => {
    expect(resolveReply(commandList, viewerMessage('!ping 元気ですか'), botId)).toBe('@shichousha pong')
  })

  it('大文字で書かれていてもコマンドとして扱う', () => {
    expect(resolveReply(commandList, viewerMessage('!PING'), botId)).toBe('@shichousha pong')
  })

  it('前に空白があってもコマンドとして扱う', () => {
    expect(resolveReply(commandList, viewerMessage('  !ping'), botId)).toBe('@shichousha pong')
  })

  it('bot自身の発言には応答しない（応答し続けて止まらなくなるため）', () => {
    const botMessage: ChatMessage = {
      broadcasterUserId: '12345',
      messageId: 'message-id-9999',
      chatterUserId: botId,
      chatterUserLogin: 'haishinsha_bot',
      chatterUserName: '配信者のbot',
      text: '!ping',
      badges: [],
    }

    expect(resolveReply(commandList, botMessage, botId)).toBeNull()
  })

  it('コマンドではない普通の発言には応答しない', () => {
    expect(resolveReply(commandList, viewerMessage('こんばんは'), botId)).toBeNull()
  })

  it('知らないコマンドには応答しない', () => {
    expect(resolveReply(commandList, viewerMessage('!shiranai'), botId)).toBeNull()
  })

  it('感嘆符だけの発言には応答しない', () => {
    expect(resolveReply(commandList, viewerMessage('!'), botId)).toBeNull()
  })

  it('文中に出てきたコマンドには応答しない（先頭のときだけ）', () => {
    expect(resolveReply(commandList, viewerMessage('さっき !ping と打ちました'), botId)).toBeNull()
  })

  it('コマンドが1つも登録されていなければ、何にも応答しない', () => {
    expect(resolveReply([], viewerMessage('!ping'), botId)).toBeNull()
  })
})

describe('あらすじの差し込み語', () => {
  const summaryCommand: BotCommand[] = [{ name: 'summary', reply: 'これまでのあらすじ: {summary}' }]

  it('{summary} を、貯めてあるあらすじに置き換える', () => {
    expect(resolveReply(summaryCommand, viewerMessage('!summary'), botId, '配信者は新しいゲームを遊んでいます')).toBe(
      'これまでのあらすじ: 配信者は新しいゲームを遊んでいます',
    )
  })

  it('あらすじがまだ無くても、無応答にならずその旨を返す', () => {
    expect(resolveReply(summaryCommand, viewerMessage('!summary'), botId, null)).toBe('これまでのあらすじ: まだあらすじがありません')
  })

  it('{user} と一緒に使える', () => {
    const command: BotCommand[] = [{ name: 'summary', reply: '@{user} {summary}' }]

    expect(resolveReply(command, viewerMessage('!summary'), botId, 'ボス戦の最中です')).toBe('@shichousha ボス戦の最中です')
  })
})

describe('needsStreamSummary', () => {
  it('応答文に {summary} があれば true', () => {
    expect(needsStreamSummary({ name: 'summary', reply: 'これまでのあらすじ: {summary}' })).toBe(true)
  })

  it('応答文に {summary} が無ければ false（あらすじを読みに行かせないため）', () => {
    expect(needsStreamSummary({ name: 'ping', reply: '@{user} pong' })).toBe(false)
  })
})

describe('BGMの差し込み語', () => {
  const bgmCommand: BotCommand[] = [{ name: 'bgm', reply: '@{user} いまの曲: {bgm}' }]
  const playingTrack = { title: 'ひだまりの午後', credit: '音楽: 甘茶の音楽工房', creditUrl: 'https://amachamusic.chagasi.com/' }

  it('{bgm} を、流している曲のクレジットに置き換える', () => {
    expect(resolveReply(bgmCommand, viewerMessage('!bgm'), botId, null, playingTrack)).toBe(
      '@shichousha いまの曲: 「ひだまりの午後」 音楽: 甘茶の音楽工房 https://amachamusic.chagasi.com/',
    )
  })

  it('曲を止めていても、無応答にならず流していないと返す', () => {
    expect(resolveReply(bgmCommand, viewerMessage('!bgm'), botId, null, null)).toBe('@shichousha いまの曲: いまはBGMを流していません')
  })

  it('{summary} と一緒に使える', () => {
    const command: BotCommand[] = [{ name: 'ima', reply: '{summary} / {bgm}' }]

    expect(resolveReply(command, viewerMessage('!ima'), botId, 'ボス戦の最中です', { ...playingTrack, creditUrl: '' })).toBe(
      'ボス戦の最中です / 「ひだまりの午後」 音楽: 甘茶の音楽工房',
    )
  })
})

describe('差し込み語の置き換えは応答文だけを1回見る', () => {
  it('あらすじの中に {bgm} という文字列があっても、置き換えない', () => {
    const command: BotCommand[] = [{ name: 'summary', reply: 'あらすじ: {summary}' }]

    expect(resolveReply(command, viewerMessage('!summary'), botId, '{bgm} コマンドの話をしました', null)).toBe(
      'あらすじ: {bgm} コマンドの話をしました',
    )
  })
})

describe('needsBgmCredit', () => {
  it('応答文に {bgm} があれば true', () => {
    expect(needsBgmCredit({ name: 'bgm', reply: 'いまの曲: {bgm}' })).toBe(true)
  })

  it('応答文に {bgm} が無ければ false（曲を読みに行かせないため）', () => {
    expect(needsBgmCredit({ name: 'ping', reply: '@{user} pong' })).toBe(false)
  })
})
