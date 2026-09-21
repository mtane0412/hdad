/**
 * チャットボットの状態の読み書き（chat-store.ts）のテスト
 *
 * メモリ上のSQLite（fake-database.ts）に migrations/ を適用して確かめる。特に重要なのは次の2点。
 * - 同じ通知が再送されても、二度応答しないこと
 * - クールダウン中は応答せず、明けたら応答すること
 */
import { describe, expect, it } from 'vitest'
import { consumeCooldown, reserveChatReply } from './chat-store'
import { createFakeDatabase } from './fake-database'

const 現在時刻 = Date.UTC(2026, 8, 21, 12, 0, 0)
const 一分 = 60 * 1000

describe('reserveChatReply', () => {
  it('はじめてのメッセージIDなら、鍵を確保できる', async () => {
    const db = createFakeDatabase()

    expect(await reserveChatReply(db, 'chat-message-1', 現在時刻)).toBe(true)
  })

  it('同じメッセージIDで二度目は確保できない（Twitchの再送で二重に応答しないため）', async () => {
    const db = createFakeDatabase()
    await reserveChatReply(db, 'chat-message-1', 現在時刻)

    expect(await reserveChatReply(db, 'chat-message-1', 現在時刻 + 1000)).toBe(false)
  })

  it('別のメッセージIDなら確保できる', async () => {
    const db = createFakeDatabase()
    await reserveChatReply(db, 'chat-message-1', 現在時刻)

    expect(await reserveChatReply(db, 'chat-message-2', 現在時刻)).toBe(true)
  })

  it('1時間より古い鍵は、新しい鍵を確保するときに消す（増え続けないようにするため）', async () => {
    const db = createFakeDatabase()
    await reserveChatReply(db, 'furui-message', 現在時刻)

    // 2時間後に別のメッセージで確保すると、古い鍵が消える
    await reserveChatReply(db, 'atarashii-message', 現在時刻 + 120 * 一分)

    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM replied_chat_messages').get()).toEqual({ count: 1 })
  })
})

describe('consumeCooldown', () => {
  it('はじめて使うコマンドなら、クールダウンを消費できる', async () => {
    const db = createFakeDatabase()

    expect(await consumeCooldown(db, 'aisatsu', 10, 現在時刻)).toBe(true)
  })

  it('クールダウン中は消費できない', async () => {
    const db = createFakeDatabase()
    await consumeCooldown(db, 'aisatsu', 60, 現在時刻)

    // 30秒後はまだクールダウン中（60秒）
    expect(await consumeCooldown(db, 'aisatsu', 60, 現在時刻 + 30 * 1000)).toBe(false)
  })

  it('クールダウンが明けたら、また消費できる', async () => {
    const db = createFakeDatabase()
    await consumeCooldown(db, 'aisatsu', 60, 現在時刻)

    expect(await consumeCooldown(db, 'aisatsu', 60, 現在時刻 + 61 * 1000)).toBe(true)
  })

  it('クールダウンが0なら、続けて消費できる（毎回応答する）', async () => {
    const db = createFakeDatabase()
    await consumeCooldown(db, 'aisatsu', 0, 現在時刻)

    expect(await consumeCooldown(db, 'aisatsu', 0, 現在時刻 + 1)).toBe(true)
  })

  it('コマンドごとに別々に数える', async () => {
    const db = createFakeDatabase()
    await consumeCooldown(db, 'aisatsu', 60, 現在時刻)

    expect(await consumeCooldown(db, 'discord', 60, 現在時刻)).toBe(true)
  })

  it('消費できなかったときは、最後に使った時刻を更新しない（更新すると、連打でいつまでも明けなくなる）', async () => {
    const db = createFakeDatabase()
    await consumeCooldown(db, 'aisatsu', 60, 現在時刻)

    // クールダウン中に何度も試す
    await consumeCooldown(db, 'aisatsu', 60, 現在時刻 + 30 * 1000)
    await consumeCooldown(db, 'aisatsu', 60, 現在時刻 + 50 * 1000)

    // 最初に使った時刻から60秒で明ける
    expect(await consumeCooldown(db, 'aisatsu', 60, 現在時刻 + 61 * 1000)).toBe(true)
  })
})
