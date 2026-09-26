/**
 * 状態を持つ条件の判定（alert-state.ts）のテスト
 *
 * 「その配信で初めての発言か」「このチャンネルで初めての発言か」「最後の発言から何日空いているか」は
 * 通知の中身だけでは決まらないため、照合の前にデータベースを見て決める。ここで確かめたいのは次の4点である。
 * - その条件を使うトリガーが1件もなければ、データベースを触らない（チャットは件数の桁が違うため）
 * - 同じ配信の2回目以降の発言では firstChatOfStream が false になる
 * - 視聴者の記録から決まる条件（firstChatEver・returningAfter）を使うときだけ、その記録を読む
 * - 発言以外の通知では、どの判定も「当てはまらない」を返す
 */
import { describe, expect, it } from 'vitest'
import type { AlertConfig } from './alert-config'
import { resolveConditionState } from './alert-state'
import type { ChatMessage } from './chat-command'
import { createFakeDatabase } from './fake-database'
import { recordViewerMessage } from './viewer-store'

const 現在時刻 = Date.UTC(2026, 8, 21, 12, 0, 0)

/** firstChatOfStream の条件を持つ設定 */
const 初回の設定: AlertConfig = {
  triggers: [{ kind: 'welcome', actions: [{ type: 'chat', message: 'おかえりなさい！' }] }],
}

/** 状態を持つ条件をひとつも持たない設定 */
const 条件なしの設定: AlertConfig = {
  triggers: [{ kind: 'everyMessage', actions: [{ type: 'chat', message: 'どうも' }] }],
}

/** firstChatEver の条件を持つ設定（視聴者の記録を読む） */
const 初見の設定: AlertConfig = {
  triggers: [{ kind: 'newViewer', actions: [{ type: 'chat', message: 'はじめまして！' }] }],
}

/** returningAfter の条件を持つ設定（視聴者の記録を読む） */
const 久しぶりの設定: AlertConfig = {
  triggers: [{ kind: 'comeback', days: 30, actions: [{ type: 'chat', message: 'お久しぶりです！' }] }],
}

/** どの判定も「当てはまらない」状態 */
const どれも当てはまらない = { firstChatOfStream: false, firstChatEver: false, daysSinceLastChat: null }

/** 視聴者の記録を1件作る（発言の記録は webhook-routes.ts が照合より先に済ませる） */
const 発言を記録する = async (db: ReturnType<typeof createFakeDatabase>, messageId: string, now: number): Promise<void> => {
  await recordViewerMessage(db, { userId: '発言者ID', login: 'tanaka_taro', displayName: '田中太郎', badges: [], messageId }, now)
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
  it('状態を持つ条件を使うトリガーがなければ、データベースを触らずにどれも当てはまらないと返す', async () => {
    const db = createFakeDatabase()
    配信を始める(db)
    // 記録のない人なので、視聴者の記録を読んでいれば firstChatEver は true になるはず
    expect(await resolveConditionState(db, 条件なしの設定, 発言(), 現在時刻)).toEqual(どれも当てはまらない)
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM first_chatters').get()).toEqual({ count: 0 })
  })

  it('その条件を使うトリガーがあり、その配信で初めての発言なら true を返す', async () => {
    const db = createFakeDatabase()
    配信を始める(db)

    expect(await resolveConditionState(db, 初回の設定, 発言(), 現在時刻)).toEqual({ ...どれも当てはまらない, firstChatOfStream: true })
  })

  it('同じ人の2回目の発言では false を返す', async () => {
    const db = createFakeDatabase()
    配信を始める(db)
    await resolveConditionState(db, 初回の設定, 発言(), 現在時刻)

    expect(await resolveConditionState(db, 初回の設定, 発言({ messageId: '発言ID-2' }), 現在時刻 + 1000)).toEqual(どれも当てはまらない)
  })

  it('発言以外の通知（発言を渡さない場合）ではどれも当てはまらないと返す', async () => {
    const db = createFakeDatabase()
    配信を始める(db)

    expect(await resolveConditionState(db, 初回の設定, null, 現在時刻)).toEqual(どれも当てはまらない)
  })

  it('firstChatEver の条件を使うトリガーがあり、記録のない人の発言なら firstChatEver に true を返す', async () => {
    const db = createFakeDatabase()

    expect(await resolveConditionState(db, 初見の設定, 発言(), 現在時刻)).toEqual({ ...どれも当てはまらない, firstChatEver: true })
  })

  it('記録のある人の発言では firstChatEver に false を返し、空いた日数を添える', async () => {
    const db = createFakeDatabase()
    await 発言を記録する(db, '発言ID-1', 現在時刻 - 40 * 24 * 60 * 60 * 1000)
    // webhook-routes.ts と同じ順序（記録してから照合）で、いまの発言も先に記録しておく
    await 発言を記録する(db, '発言ID-2', 現在時刻)

    expect(await resolveConditionState(db, 初見の設定, 発言({ messageId: '発言ID-2' }), 現在時刻)).toEqual({
      firstChatOfStream: false,
      firstChatEver: false,
      daysSinceLastChat: 40,
    })
  })

  it('returningAfter の条件だけを使うトリガーでも、視聴者の記録を読む', async () => {
    const db = createFakeDatabase()
    await 発言を記録する(db, '発言ID-1', 現在時刻 - 40 * 24 * 60 * 60 * 1000)
    await 発言を記録する(db, '発言ID-2', 現在時刻)

    expect(await resolveConditionState(db, 久しぶりの設定, 発言({ messageId: '発言ID-2' }), 現在時刻)).toEqual({
      firstChatOfStream: false,
      firstChatEver: false,
      daysSinceLastChat: 40,
    })
  })

  it('firstChatOfStream と firstChatEver のトリガーが並んでいれば、両方を判定する', async () => {
    const db = createFakeDatabase()
    配信を始める(db)
    // 1つのメニュー項目が持つ条件は1件までなので、2つのトリガーを並べて両方の判定が要る状態を作る
    const 両方の設定: AlertConfig = {
      triggers: [
        { kind: 'welcome', actions: [{ type: 'chat', message: 'おかえりなさい！' }] },
        { kind: 'newViewer', actions: [{ type: 'chat', message: 'はじめまして！' }] },
      ],
    }

    expect(await resolveConditionState(db, 両方の設定, 発言(), 現在時刻)).toEqual({
      firstChatOfStream: true,
      firstChatEver: true,
      daysSinceLastChat: null,
    })
  })
})
