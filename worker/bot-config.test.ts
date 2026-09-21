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

const 挨拶のコマンド: StoredCommand = { name: 'aisatsu', reply: '@{user} こんばんは', cooldownSeconds: 10 }
const Discordのコマンド: StoredCommand = { name: 'discord', reply: 'Discordはこちらです: https://example.com/discord', cooldownSeconds: 60 }

/** 検証で見つかった問題点の一覧を取り出す */
const 問題点 = (input: unknown): readonly string[] => {
  try {
    parseBotConfig(input)
  } catch (error) {
    return (error as { problems: readonly string[] }).problems
  }
  throw new Error('検証が通ってしまいました')
}

describe('parseBotConfig', () => {
  it('正しい内容はそのまま保存用の形にする', () => {
    expect(parseBotConfig({ commands: [挨拶のコマンド, Discordのコマンド] })).toEqual({ commands: [挨拶のコマンド, Discordのコマンド] })
  })

  it('コマンドが空でも通る（まだ1つも登録していない状態）', () => {
    expect(parseBotConfig({ commands: [] })).toEqual(EMPTY_CONFIG)
  })

  it('commands が配列でなければ拒否する', () => {
    expect(問題点({ commands: 'まだありません' })).toEqual(['commands: 配列で指定してください'])
  })

  it('コマンド名が空なら拒否する', () => {
    expect(問題点({ commands: [{ ...挨拶のコマンド, name: '' }] })).toEqual([expect.stringContaining('commands[0].name')])
  })

  it('コマンド名に空白が含まれていたら拒否する（先頭の語だけをコマンドとして見るため）', () => {
    expect(問題点({ commands: [{ ...挨拶のコマンド, name: 'aisatsu suru' }] })).toEqual([expect.stringContaining('commands[0].name')])
  })

  it('コマンド名に ! が含まれていたら拒否する（! は入力時に付けるもので、名前には含めない）', () => {
    expect(問題点({ commands: [{ ...挨拶のコマンド, name: '!aisatsu' }] })).toEqual([expect.stringContaining('commands[0].name')])
  })

  it('大文字小文字だけが違うコマンド名は、重複として拒否する（判定は大文字小文字を無視するため）', () => {
    const 問題 = 問題点({ commands: [挨拶のコマンド, { ...挨拶のコマンド, name: 'AISATSU' }] })
    expect(問題).toEqual([expect.stringContaining('commands[1].name')])
    expect(問題[0]).toContain('重複')
  })

  it('応答文が空なら拒否する', () => {
    expect(問題点({ commands: [{ ...挨拶のコマンド, reply: '' }] })).toEqual([expect.stringContaining('commands[0].reply')])
  })

  it('応答文が空白だけなら拒否する（Twitchは空白だけのメッセージを受け付けないため）', () => {
    expect(問題点({ commands: [{ ...挨拶のコマンド, reply: '   ' }] })).toEqual([expect.stringContaining('commands[0].reply')])
  })

  it('応答文が500文字を超えたら拒否する（Twitchが受け付けないため）', () => {
    expect(問題点({ commands: [{ ...挨拶のコマンド, reply: 'あ'.repeat(501) }] })).toEqual([expect.stringContaining('commands[0].reply')])
  })

  it('{user} が置き換わったときに500文字を超える応答文は拒否する（送る段になって失敗しないようにするため）', () => {
    // {user} の6文字が、Twitchのログイン名の上限である25文字に置き換わると、500文字を超える
    const 置き換えると超える応答文 = `${'あ'.repeat(490)}{user}`

    expect(置き換えると超える応答文.length).toBeLessThanOrEqual(500)
    expect(問題点({ commands: [{ ...挨拶のコマンド, reply: 置き換えると超える応答文 }] })).toEqual([expect.stringContaining('commands[0].reply')])
  })

  it('{user} を含んでいても、置き換わったあとが500文字以内なら通る', () => {
    const 収まる応答文 = `${'あ'.repeat(400)}{user}`
    expect(parseBotConfig({ commands: [{ ...挨拶のコマンド, reply: 収まる応答文 }] }).commands).toHaveLength(1)
  })

  it('クールダウンが負の数なら拒否する', () => {
    expect(問題点({ commands: [{ ...挨拶のコマンド, cooldownSeconds: -1 }] })).toEqual([expect.stringContaining('commands[0].cooldownSeconds')])
  })

  it('クールダウンが整数でなければ拒否する', () => {
    expect(問題点({ commands: [{ ...挨拶のコマンド, cooldownSeconds: 1.5 }] })).toEqual([expect.stringContaining('commands[0].cooldownSeconds')])
  })

  it('クールダウンが0なら通る（毎回応答する）', () => {
    expect(parseBotConfig({ commands: [{ ...挨拶のコマンド, cooldownSeconds: 0 }] }).commands[0]?.cooldownSeconds).toBe(0)
  })

  it('問題点は最初の1件で止めず、すべて集めてから拒否する', () => {
    const 問題 = 問題点({ commands: [{ name: '', reply: '', cooldownSeconds: -1 }] })

    expect(問題).toHaveLength(3)
    expect(問題.join(' ')).toContain('name')
    expect(問題.join(' ')).toContain('reply')
    expect(問題.join(' ')).toContain('cooldownSeconds')
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
    await saveBotConfig(store, { commands: [挨拶のコマンド] })

    expect(await loadBotConfig(store)).toEqual({ commands: [挨拶のコマンド] })
  })

  it('まだ保存していなければ、コマンドなしの設定を返す', async () => {
    expect(await loadBotConfig(createFakeStore())).toEqual(EMPTY_CONFIG)
  })

  it('アラートの設定とは別のキーに保存する', async () => {
    const store = createFakeStore()
    await saveBotConfig(store, { commands: [挨拶のコマンド] })

    expect([...store.entries.keys()]).toEqual(['bot-commands'])
  })
})
