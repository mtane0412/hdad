/**
 * チャットボットのコマンドの設定（bot-config.ts）のテスト
 *
 * 管理画面から送られてきた内容を検証して保存する。特に重要なのは次の2点。
 * - 問題点を最初の1件で止めず、すべて集めてから拒否すること（管理画面で一度に直せるようにするため）
 * - Twitchが受け付けない内容（500文字を超える応答文など）を、保存の時点で止めること
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_CONFIG, loadBotConfig, parseBotConfig, saveBotConfig, type StoredCommand } from './bot-config'
import { createFakeStore } from './fake-store'

const greetingCommand: StoredCommand = { name: 'aisatsu', reply: '@{user} こんばんは', cooldownSeconds: 10 }
const discordCommand: StoredCommand = { name: 'discord', reply: 'Discordはこちらです: https://example.com/discord', cooldownSeconds: 60 }

/** 検証で見つかった問題点の一覧を取り出す */
const issues = (input: unknown): readonly string[] => {
  try {
    parseBotConfig(input)
  } catch (error) {
    return (error as { problems: readonly string[] }).problems
  }
  throw new Error('検証が通ってしまいました')
}

describe('parseBotConfig', () => {
  it('正しい内容はそのまま保存用の形にする', () => {
    expect(parseBotConfig({ commands: [greetingCommand, discordCommand] })).toEqual({ commands: [greetingCommand, discordCommand] })
  })

  it('コマンドが空でも通る（まだ1つも登録していない状態）', () => {
    expect(parseBotConfig({ commands: [] })).toEqual(EMPTY_CONFIG)
  })

  it('commands が配列でなければ拒否する', () => {
    expect(issues({ commands: 'まだありません' })).toEqual(['commands: 配列で指定してください'])
  })

  it('コマンド名が空なら拒否する', () => {
    expect(issues({ commands: [{ ...greetingCommand, name: '' }] })).toEqual([expect.stringContaining('commands[0].name')])
  })

  it('コマンド名に空白が含まれていたら拒否する（先頭の語だけをコマンドとして見るため）', () => {
    expect(issues({ commands: [{ ...greetingCommand, name: 'aisatsu suru' }] })).toEqual([expect.stringContaining('commands[0].name')])
  })

  it('コマンド名に ! が含まれていたら拒否する（! は入力時に付けるもので、名前には含めない）', () => {
    expect(issues({ commands: [{ ...greetingCommand, name: '!aisatsu' }] })).toEqual([expect.stringContaining('commands[0].name')])
  })

  it('大文字小文字だけが違うコマンド名は、重複として拒否する（判定は大文字小文字を無視するため）', () => {
    const issue = issues({ commands: [greetingCommand, { ...greetingCommand, name: 'AISATSU' }] })
    expect(issue).toEqual([expect.stringContaining('commands[1].name')])
    expect(issue[0]).toContain('重複')
  })

  it('組み込みのコマンド（task・done）と同じ名前は、大文字小文字を問わず拒否する（組み込みが先に応えて、登録した応答が届かないため）', () => {
    const issue = issues({ commands: [{ ...greetingCommand, name: 'task' }, { ...discordCommand, name: 'DONE' }] })
    expect(issue).toEqual([expect.stringContaining('commands[0].name'), expect.stringContaining('commands[1].name')])
    expect(issue[0]).toContain('組み込み')
  })

  it('応答文が空なら拒否する', () => {
    expect(issues({ commands: [{ ...greetingCommand, reply: '' }] })).toEqual([expect.stringContaining('commands[0].reply')])
  })

  it('応答文が空白だけなら拒否する（Twitchは空白だけのメッセージを受け付けないため）', () => {
    expect(issues({ commands: [{ ...greetingCommand, reply: '   ' }] })).toEqual([expect.stringContaining('commands[0].reply')])
  })

  it('応答文が500文字を超えたら拒否する（Twitchが受け付けないため）', () => {
    expect(issues({ commands: [{ ...greetingCommand, reply: 'あ'.repeat(501) }] })).toEqual([expect.stringContaining('commands[0].reply')])
  })

  it('{user} が置き換わったときに500文字を超える応答文は拒否する（送る段になって失敗しないようにするため）', () => {
    // {user} の6文字が、Twitchのログイン名の上限である25文字に置き換わると、500文字を超える
    const overflowingReply = `${'あ'.repeat(490)}{user}`

    expect(overflowingReply.length).toBeLessThanOrEqual(500)
    expect(issues({ commands: [{ ...greetingCommand, reply: overflowingReply }] })).toEqual([expect.stringContaining('commands[0].reply')])
  })

  it('{user} を含んでいても、置き換わったあとが500文字以内なら通る', () => {
    const fittingReply = `${'あ'.repeat(400)}{user}`
    expect(parseBotConfig({ commands: [{ ...greetingCommand, reply: fittingReply }] }).commands).toHaveLength(1)
  })

  it('{summary} が置き換わったときに500文字を超える応答文は拒否する（あらすじは最大400文字になるため）', () => {
    const overflowingReply = `${'あ'.repeat(101)}{summary}`

    expect(issues({ commands: [{ ...greetingCommand, reply: overflowingReply }] })).toEqual([expect.stringContaining('commands[0].reply')])
  })

  it('{bgm} が置き換わったときに500文字を超える応答文は拒否する（曲のクレジットは最大364文字になるため）', () => {
    const overflowingReply = `${'あ'.repeat(137)}{bgm}`

    expect(() => parseBotConfig({ commands: [{ ...greetingCommand, reply: overflowingReply }] })).toThrow(/\{bgm\} は最大364文字/)
  })

  it('{bgm} を含んでいても、置き換わったあとが500文字以内なら通る', () => {
    const fittingReply = `${'あ'.repeat(136)}{bgm}`

    expect(parseBotConfig({ commands: [{ ...greetingCommand, reply: fittingReply }] }).commands).toHaveLength(1)
  })

  it('{worktime} が置き換わったときに500文字を超える応答文は拒否する（作業した時間の合計は最大30文字と見積もるため）', () => {
    const overflowingReply = `${'あ'.repeat(471)}{worktime}`

    expect(() => parseBotConfig({ commands: [{ ...greetingCommand, reply: overflowingReply }] })).toThrow(/\{worktime\} は最大30文字/)
  })

  it('{worktime} を含んでいても、置き換わったあとが500文字以内なら通る', () => {
    const fittingReply = `${'あ'.repeat(470)}{worktime}`

    expect(parseBotConfig({ commands: [{ ...greetingCommand, reply: fittingReply }] }).commands).toHaveLength(1)
  })

  it('{summary} を含んでいても、置き換わったあとが500文字以内なら通る', () => {
    expect(parseBotConfig({ commands: [{ ...greetingCommand, reply: 'これまでのあらすじ: {summary}' }] }).commands).toHaveLength(1)
  })

  it('クールダウンが負の数なら拒否する', () => {
    expect(issues({ commands: [{ ...greetingCommand, cooldownSeconds: -1 }] })).toEqual([expect.stringContaining('commands[0].cooldownSeconds')])
  })

  it('クールダウンが整数でなければ拒否する', () => {
    expect(issues({ commands: [{ ...greetingCommand, cooldownSeconds: 1.5 }] })).toEqual([expect.stringContaining('commands[0].cooldownSeconds')])
  })

  it('クールダウンが0なら通る（毎回応答する）', () => {
    expect(parseBotConfig({ commands: [{ ...greetingCommand, cooldownSeconds: 0 }] }).commands[0]?.cooldownSeconds).toBe(0)
  })

  it('問題点は最初の1件で止めず、すべて集めてから拒否する', () => {
    const issue = issues({ commands: [{ name: '', reply: '', cooldownSeconds: -1 }] })

    expect(issue).toHaveLength(3)
    expect(issue.join(' ')).toContain('name')
    expect(issue.join(' ')).toContain('reply')
    expect(issue.join(' ')).toContain('cooldownSeconds')
  })

  it('何の設定の問題かが分かるメッセージになる', () => {
    let message = ''
    try {
      parseBotConfig({ commands: 'まだありません' })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('コマンドの設定')
  })
})

describe('saveBotConfig / loadBotConfig', () => {
  it('保存した設定をそのまま読み出せる', async () => {
    const store = createFakeStore()
    await saveBotConfig(store, { commands: [greetingCommand] })

    expect(await loadBotConfig(store)).toEqual({ commands: [greetingCommand] })
  })

  it('まだ保存していなければ、コマンドなしの設定を返す', async () => {
    expect(await loadBotConfig(createFakeStore())).toEqual(EMPTY_CONFIG)
  })

  it('アラートの設定とは別のキーに保存する', async () => {
    const store = createFakeStore()
    await saveBotConfig(store, { commands: [greetingCommand] })

    expect([...store.entries.keys()]).toEqual(['bot-commands'])
  })
})
