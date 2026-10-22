/**
 * 人形の組み込みのコマンド（doll-command.ts）のテスト
 *
 * 次の点を確かめる。
 * - !人形 と !人形ランキング を、最初の語だけで読み取ること（続けて打った別の語や、ほかのコマンドは読み取らない）
 * - !人形 は発言者のいまの人形の所持数を、!人形ランキング はランキングを、合成ページの素材「人形の獲得」へ出すこと
 * - 同じ発言の再送では2度出さないこと、続けて打たれても間を空けるまで出さないこと（所持数は人ごと、ランキングは全体で）
 * - 出せないとき（いまの人形が無いなど）は投げずに doll-show-failed を記録すること（Twitch に再送させないため）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage } from './chat-command'
import type { DollSetInput } from './doll'
import { DOLL_COMMAND_COOLDOWN_SECONDS, handleDollCommand, readDollCommand } from './doll-command'
import { changeDolls, insertDollSet, selectCurrentDollSet } from './doll-store'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'
import { listFailures } from './stats-store'

const NOW = Date.parse('2026-10-22T12:00:00.000Z')
const MILLISECONDS_PER_SECOND = 1000

/** クマの人形の組 */
const bears: DollSetInput = {
  normal: { name: 'クマ人形', mediaId: 'image-bear' },
  super: { name: 'スーパークマ人形', mediaId: 'image-super-bear' },
}

/** 視聴者「hanako」の Twitch のユーザー ID */
const HANAKO = '1001'
/** 視聴者「taro」の Twitch のユーザー ID */
const TARO = '1002'

let db: ReturnType<typeof createFakeDatabase>
let alerts: ReturnType<typeof createFakeAlertChannel>

beforeEach(() => {
  db = createFakeDatabase()
  alerts = createFakeAlertChannel()
})

const contextAt = (now = NOW) => ({ env: { DB: db, STORE: createFakeStore({ 'overlay-key': 'secret' }), ALERTS: alerts.namespace }, now })

/** 発言1件 */
const chatOf = (text: string, { messageId = 'chat-1', userId = HANAKO, userName = 'はなこ' } = {}): ChatMessage => ({
  broadcasterUserId: '12345',
  messageId,
  chatterUserId: userId,
  chatterUserLogin: 'hanako',
  chatterUserName: userName,
  text,
  badges: [],
})

/** いまの人形を選び、はなこにスーパー人形を1つ渡した状態にする */
const prepare = async (): Promise<void> => {
  const set = await insertDollSet(db, bears, NOW)
  await selectCurrentDollSet(db, set.id)
  await changeDolls(db, { userId: HANAKO, userName: 'はなこ', kind: 'super', delta: 1, reason: 'manual', sourceId: 'manual-1' }, NOW)
}

describe('readDollCommand', () => {
  it('!人形 は所持数、!人形ランキング はランキングとして読み、後ろに続く文字は無視する', () => {
    expect(readDollCommand('!人形')).toBe('standing')
    expect(readDollCommand('  !人形 いくつ？')).toBe('standing')
    expect(readDollCommand('!人形ランキング')).toBe('ranking')
  })

  it('コマンドでない発言・別の語は読み取らない', () => {
    expect(readDollCommand('人形かわいい')).toBeNull()
    expect(readDollCommand('!人形劇')).toBeNull()
    expect(readDollCommand('!task 人形を作る')).toBeNull()
  })
})

describe('handleDollCommand', () => {
  it('!人形 なら、発言者の表示名と所持数を合成ページへ出し、扱ったことを返す', async () => {
    await prepare()

    expect(await handleDollCommand(contextAt(), chatOf('!人形'))).toBe(true)

    expect(alerts.pushedDollAwards).toEqual([
      expect.objectContaining({ type: 'standing', userName: 'はなこ', super: expect.objectContaining({ count: 1 }) }),
    ])
  })

  it('!人形ランキング なら、ランキングを合成ページへ出す', async () => {
    await prepare()

    expect(await handleDollCommand(contextAt(), chatOf('!人形ランキング'))).toBe(true)

    expect(alerts.pushedDollAwards).toEqual([expect.objectContaining({ type: 'ranking', entries: [expect.objectContaining({ userName: 'はなこ' })] })])
  })

  it('人形のコマンドでなければ何もせず、扱わなかったことを返す', async () => {
    await prepare()

    expect(await handleDollCommand(contextAt(), chatOf('こんにちは'))).toBe(false)
    expect(alerts.pushedDollAwards).toEqual([])
  })

  it('同じ発言の再送では2度出さない', async () => {
    await prepare()

    await handleDollCommand(contextAt(), chatOf('!人形'))
    await handleDollCommand(contextAt(), chatOf('!人形'))

    expect(alerts.pushedDollAwards).toHaveLength(1)
  })

  it('所持数は同じ人が間を空けずに打っても出さないが、ほかの人の分は出す。間を空ければまた出す', async () => {
    await prepare()
    const soon = NOW + MILLISECONDS_PER_SECOND
    const later = NOW + DOLL_COMMAND_COOLDOWN_SECONDS * MILLISECONDS_PER_SECOND

    await handleDollCommand(contextAt(), chatOf('!人形', { messageId: 'chat-1' }))
    await handleDollCommand(contextAt(soon), chatOf('!人形', { messageId: 'chat-2' }))
    await handleDollCommand(contextAt(soon), chatOf('!人形', { messageId: 'chat-3', userId: TARO, userName: 'たろう' }))
    await handleDollCommand(contextAt(later), chatOf('!人形', { messageId: 'chat-4' }))

    expect(alerts.pushedDollAwards.map((message) => (message.type === 'standing' ? message.userName : message.type))).toEqual(['はなこ', 'たろう', 'はなこ'])
  })

  it('ランキングは誰が打っても、間を空けるまで出さない', async () => {
    await prepare()
    const soon = NOW + MILLISECONDS_PER_SECOND

    await handleDollCommand(contextAt(), chatOf('!人形ランキング', { messageId: 'chat-1' }))
    await handleDollCommand(contextAt(soon), chatOf('!人形ランキング', { messageId: 'chat-2', userId: TARO, userName: 'たろう' }))

    expect(alerts.pushedDollAwards).toHaveLength(1)
  })

  it('いまの人形が無くて出せないときは、投げずに doll-show-failed を記録する', async () => {
    expect(await handleDollCommand(contextAt(), chatOf('!人形'))).toBe(true)

    expect(alerts.pushedDollAwards).toEqual([])
    expect((await listFailures(db)).map(({ code }) => code)).toEqual(['doll-show-failed'])
  })
})
