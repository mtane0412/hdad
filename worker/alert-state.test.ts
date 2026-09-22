/**
 * 状態を持つ条件の判定（alert-state.ts）のテスト
 *
 * 「その配信で初めての発言か」は通知の中身だけでは決まらないため、照合の前にデータベースを見て決める。
 * ここで確かめたいのは次の3点である。
 * - その条件を使うトリガーが1件もなければ、データベースを触らない（チャットは件数の桁が違うため）
 * - 同じ配信の2回目以降の発言では false になる
 * - 発言以外の通知では、常に false を返す
 */
import { describe, expect, it } from 'vitest'
import type { AlertConfig } from './alert-config'
import { resolveConditionState } from './alert-state'
import type { ChatMessage } from './chat-command'
import { createFakeDatabase } from './fake-database'

const CHAT_MESSAGE = 'channel.chat.message'
const 現在時刻 = Date.UTC(2026, 8, 21, 12, 0, 0)

/** firstChatOfStream の条件を持つ設定 */
const 初回の設定: AlertConfig = {
  triggers: [{ event: CHAT_MESSAGE, conditions: [{ kind: 'firstChatOfStream' }], actions: [{ type: 'chat', message: 'おかえりなさい！' }] }],
}

/** firstChatOfStream の条件を持たない設定 */
const 条件なしの設定: AlertConfig = {
  triggers: [{ event: CHAT_MESSAGE, conditions: [], actions: [{ type: 'chat', message: 'どうも' }] }],
}

const 発言 = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  broadcasterUserId: '配信者ID',
  messageId: '発言ID-1',
  chatterUserId: '発言者ID',
  chatterUserLogin: 'tanaka_taro',
  chatterUserName: '田中太郎',
  text: 'おはようございます',
  badges: [],
  ...overrides,
})

/** 配信中の区切りを1件作る */
const 配信を始める = (db: ReturnType<typeof createFakeDatabase>): void => {
  db.sqlite
    .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
    .run('haishin-1', new Date(現在時刻 - 60 * 1000).toISOString(), '朝配信', 'Just Chatting')
}

describe('resolveConditionState', () => {
  it('firstChatOfStream の条件を使うトリガーがなければ、データベースを触らずに false を返す', async () => {
    const db = createFakeDatabase()
    配信を始める(db)

    expect(await resolveConditionState(db, 条件なしの設定, 発言(), 現在時刻)).toEqual({ firstChatOfStream: false })
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM first_chatters').get()).toEqual({ count: 0 })
  })

  it('その条件を使うトリガーがあり、その配信で初めての発言なら true を返す', async () => {
    const db = createFakeDatabase()
    配信を始める(db)

    expect(await resolveConditionState(db, 初回の設定, 発言(), 現在時刻)).toEqual({ firstChatOfStream: true })
  })

  it('同じ人の2回目の発言では false を返す', async () => {
    const db = createFakeDatabase()
    配信を始める(db)
    await resolveConditionState(db, 初回の設定, 発言(), 現在時刻)

    expect(await resolveConditionState(db, 初回の設定, 発言({ messageId: '発言ID-2' }), 現在時刻 + 1000)).toEqual({ firstChatOfStream: false })
  })

  it('発言以外の通知（発言を渡さない場合）では false を返す', async () => {
    const db = createFakeDatabase()
    配信を始める(db)

    expect(await resolveConditionState(db, 初回の設定, null, 現在時刻)).toEqual({ firstChatOfStream: false })
  })
})
