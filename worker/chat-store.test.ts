/**
 * チャットボットの状態の読み書き（chat-store.ts）のテスト
 *
 * メモリ上のSQLite（fake-database.ts）に migrations/ を適用して確かめる。特に重要なのは次の2点。
 * - 同じ通知が再送されても、二度応答しないこと
 * - クールダウン中は応答せず、明けたら応答すること
 */
import { describe, expect, it } from 'vitest'
import { claimFirstChatOfStream, consumeCooldown, deleteOldFirstChatters, recordAndCountRecentMessage, reserveAnnouncementSlot, reserveChatReply } from './chat-store'
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

describe('recordAndCountRecentMessage', () => {
  const 連投 = { messageId: 'chat-message-1', chatterUserId: '11111', text: 'うおおおお', windowSeconds: 30 }

  it('はじめての文面なら、自分の1件だけを数える', async () => {
    const db = createFakeDatabase()

    expect(await recordAndCountRecentMessage(db, 連投, 現在時刻)).toBe(1)
  })

  it('同じ発言者が同じ文面を送るたびに、件数が増える', async () => {
    const db = createFakeDatabase()
    await recordAndCountRecentMessage(db, 連投, 現在時刻)
    await recordAndCountRecentMessage(db, { ...連投, messageId: 'chat-message-2' }, 現在時刻 + 1000)

    expect(await recordAndCountRecentMessage(db, { ...連投, messageId: 'chat-message-3' }, 現在時刻 + 2000)).toBe(3)
  })

  it('大文字小文字と前後の空白が違うだけの文面は、同じ文面として数える', async () => {
    const db = createFakeDatabase()
    await recordAndCountRecentMessage(db, { ...連投, text: 'CHECK THIS' }, 現在時刻)

    expect(await recordAndCountRecentMessage(db, { ...連投, messageId: 'chat-message-2', text: '  check this  ' }, 現在時刻 + 1000)).toBe(2)
  })

  it('文面が違えば別々に数える', async () => {
    const db = createFakeDatabase()
    await recordAndCountRecentMessage(db, 連投, 現在時刻)

    expect(await recordAndCountRecentMessage(db, { ...連投, messageId: 'chat-message-2', text: 'こんばんは' }, 現在時刻 + 1000)).toBe(1)
  })

  it('発言者が違えば別々に数える', async () => {
    const db = createFakeDatabase()
    await recordAndCountRecentMessage(db, 連投, 現在時刻)

    expect(await recordAndCountRecentMessage(db, { ...連投, messageId: 'chat-message-2', chatterUserId: '22222' }, 現在時刻 + 1000)).toBe(1)
  })

  it('窓（30秒）より古い発言は数えない', async () => {
    const db = createFakeDatabase()
    await recordAndCountRecentMessage(db, 連投, 現在時刻)

    expect(await recordAndCountRecentMessage(db, { ...連投, messageId: 'chat-message-2' }, 現在時刻 + 31 * 1000)).toBe(1)
  })

  it('同じ発言が再送されても、件数は増えない（Twitchの再送で連投とみなされないため）', async () => {
    const db = createFakeDatabase()
    await recordAndCountRecentMessage(db, 連投, 現在時刻)

    // Twitchが同じ通知（同じメッセージID）をもう一度届けた
    expect(await recordAndCountRecentMessage(db, 連投, 現在時刻 + 1000)).toBe(1)
  })

  it('窓より古い行は、数えるときに消す（増え続けないようにするため）', async () => {
    const db = createFakeDatabase()
    await recordAndCountRecentMessage(db, 連投, 現在時刻)

    await recordAndCountRecentMessage(db, { ...連投, messageId: 'chat-message-2', text: 'こんばんは' }, 現在時刻 + 31 * 1000)

    // 残るのは、窓の中にある2件目だけ
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM chat_recent_messages').get()).toEqual({ count: 1 })
  })
})

describe('reserveAnnouncementSlot', () => {
  const 配信者のID = '12345'

  it('直前にアナウンスを送っていなければ、待たずに送れる', async () => {
    const db = createFakeDatabase()

    expect(await reserveAnnouncementSlot(db, 配信者のID, 現在時刻)).toBe(0)
  })

  it('同じ時刻に続いた2件目は、2秒待ってから送る（アナウンスは2秒に1回しか送れないため）', async () => {
    const db = createFakeDatabase()
    await reserveAnnouncementSlot(db, 配信者のID, 現在時刻)

    expect(await reserveAnnouncementSlot(db, 配信者のID, 現在時刻)).toBe(2000)
  })

  it('3件目は4秒待つ（確保した枠が積み上がる）', async () => {
    const db = createFakeDatabase()
    await reserveAnnouncementSlot(db, 配信者のID, 現在時刻)
    await reserveAnnouncementSlot(db, 配信者のID, 現在時刻)

    expect(await reserveAnnouncementSlot(db, 配信者のID, 現在時刻)).toBe(4000)
  })

  it('1件目から1秒後に届いた2件目は、残りの1秒だけ待つ', async () => {
    const db = createFakeDatabase()
    await reserveAnnouncementSlot(db, 配信者のID, 現在時刻)

    expect(await reserveAnnouncementSlot(db, 配信者のID, 現在時刻 + 1000)).toBe(1000)
  })

  it('2秒より後に届いた2件目は、待たずに送れる', async () => {
    const db = createFakeDatabase()
    await reserveAnnouncementSlot(db, 配信者のID, 現在時刻)

    expect(await reserveAnnouncementSlot(db, 配信者のID, 現在時刻 + 3000)).toBe(0)
  })

  it('待ち時間の上限（4秒）を超えるほど詰まっていれば、枠を確保できない', async () => {
    const db = createFakeDatabase()
    await reserveAnnouncementSlot(db, 配信者のID, 現在時刻)
    await reserveAnnouncementSlot(db, 配信者のID, 現在時刻)
    await reserveAnnouncementSlot(db, 配信者のID, 現在時刻)

    // 4件目の送信時刻は6秒後になるため、確保せずに null を返す
    expect(await reserveAnnouncementSlot(db, 配信者のID, 現在時刻)).toBeNull()
  })

  it('枠を確保できなかったことで、あとの予約が遅れたりはしない（確保していないため）', async () => {
    const db = createFakeDatabase()
    await reserveAnnouncementSlot(db, 配信者のID, 現在時刻)
    await reserveAnnouncementSlot(db, 配信者のID, 現在時刻)
    await reserveAnnouncementSlot(db, 配信者のID, 現在時刻)
    await reserveAnnouncementSlot(db, 配信者のID, 現在時刻)

    // 4件目は確保できていないので、6秒後に届いた5件目は待たずに送れる
    expect(await reserveAnnouncementSlot(db, 配信者のID, 現在時刻 + 6000)).toBe(0)
  })

  it('別のチャンネルの枠は取り合わない（アナウンスの制限はチャンネルごと）', async () => {
    const db = createFakeDatabase()
    await reserveAnnouncementSlot(db, 配信者のID, 現在時刻)

    expect(await reserveAnnouncementSlot(db, '99999', 現在時刻)).toBe(0)
  })
})

describe('claimFirstChatOfStream', () => {
  /** 配信中の区切りを1件作る（stream.online の Webhook が記録するのと同じ形） */
  const 配信を始める = (db: ReturnType<typeof createFakeDatabase>, id: string, startedAt: number): void => {
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
      .run(id, new Date(startedAt).toISOString(), '朝配信', 'Just Chatting')
  }

  /** 配信中の区切りを終わらせる */
  const 配信を終える = (db: ReturnType<typeof createFakeDatabase>, endedAt: number): void => {
    db.sqlite.prepare('UPDATE stream_sessions SET ended_at = ? WHERE ended_at IS NULL').run(new Date(endedAt).toISOString())
  }

  it('配信中で、その人がまだ発言していなければ「初回」と判定する', async () => {
    const db = createFakeDatabase()
    配信を始める(db, 'haishin-1', 現在時刻 - 一分)

    expect(await claimFirstChatOfStream(db, { chatterUserId: 'tanenobu-id', messageId: 'chat-message-1' }, 現在時刻)).toBe(true)
  })

  it('同じ人が同じ配信で2回目に発言したら「初回」ではない', async () => {
    const db = createFakeDatabase()
    配信を始める(db, 'haishin-1', 現在時刻 - 一分)
    await claimFirstChatOfStream(db, { chatterUserId: 'tanenobu-id', messageId: 'chat-message-1' }, 現在時刻)

    expect(await claimFirstChatOfStream(db, { chatterUserId: 'tanenobu-id', messageId: 'chat-message-2' }, 現在時刻 + 1000)).toBe(false)
  })

  it('別の人なら、同じ配信でもそれぞれ「初回」と判定する', async () => {
    const db = createFakeDatabase()
    配信を始める(db, 'haishin-1', 現在時刻 - 一分)
    await claimFirstChatOfStream(db, { chatterUserId: 'tanenobu-id', messageId: 'chat-message-1' }, 現在時刻)

    expect(await claimFirstChatOfStream(db, { chatterUserId: 'hanako-id', messageId: 'chat-message-2' }, 現在時刻 + 1000)).toBe(true)
  })

  it('配信が変われば、同じ人でもまた「初回」と判定する', async () => {
    const db = createFakeDatabase()
    配信を始める(db, 'haishin-1', 現在時刻 - 一分)
    await claimFirstChatOfStream(db, { chatterUserId: 'tanenobu-id', messageId: 'chat-message-1' }, 現在時刻)
    配信を終える(db, 現在時刻 + 一分)
    配信を始める(db, 'haishin-2', 現在時刻 + 2 * 一分)

    expect(await claimFirstChatOfStream(db, { chatterUserId: 'tanenobu-id', messageId: 'chat-message-3' }, 現在時刻 + 3 * 一分)).toBe(true)
  })

  it('同じ発言の通知が二度届いても、どちらも同じ答え（初回）を返す（Webhookとオーバーレイで判定が食い違わないため）', async () => {
    const db = createFakeDatabase()
    配信を始める(db, 'haishin-1', 現在時刻 - 一分)

    expect(await claimFirstChatOfStream(db, { chatterUserId: 'tanenobu-id', messageId: 'chat-message-1' }, 現在時刻)).toBe(true)
    expect(await claimFirstChatOfStream(db, { chatterUserId: 'tanenobu-id', messageId: 'chat-message-1' }, 現在時刻 + 1000)).toBe(true)
  })

  it('配信していないときの発言は「初回」と判定せず、記録も残さない（テスト配信のたびに鳴らないようにするため）', async () => {
    const db = createFakeDatabase()

    expect(await claimFirstChatOfStream(db, { chatterUserId: 'tanenobu-id', messageId: 'chat-message-1' }, 現在時刻)).toBe(false)
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM first_chatters').get()).toEqual({ count: 0 })
  })

  it('配信が終わったあとの発言は「初回」と判定しない', async () => {
    const db = createFakeDatabase()
    配信を始める(db, 'haishin-1', 現在時刻 - 一分)
    配信を終える(db, 現在時刻)

    expect(await claimFirstChatOfStream(db, { chatterUserId: 'tanenobu-id', messageId: 'chat-message-1' }, 現在時刻 + 1000)).toBe(false)
  })
})

describe('deleteOldFirstChatters', () => {
  it('期限より古い記録だけを消す', async () => {
    const db = createFakeDatabase()
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
      .run('haishin-1', new Date(現在時刻 - 一分).toISOString(), '朝配信', 'Just Chatting')
    await claimFirstChatOfStream(db, { chatterUserId: 'furui-hito', messageId: 'chat-message-1' }, 現在時刻)
    await claimFirstChatOfStream(db, { chatterUserId: 'atarashii-hito', messageId: 'chat-message-2' }, 現在時刻 + 100 * 一分)

    await deleteOldFirstChatters(db, 現在時刻 + 50 * 一分)

    expect(db.sqlite.prepare('SELECT chatter_user_id FROM first_chatters').all()).toEqual([{ chatter_user_id: 'atarashii-hito' }])
  })
})
