/**
 * 作業机の組み込みコマンドとモデレーションの反映（task-desk-command.ts）のテスト
 *
 * D1 は migrations/ を適用したメモリ上のSQLite、配送先は fake-alert-channel.ts、botの送信は文言を集める関数で差し替え、次の点を確かめる。
 * - !task・!done で作業机が変わったら、いまの作業机を丸ごと押し出すこと
 * - 受け付けないとき（空・長すぎる・配信外・宣言が無い）は、botが理由を返し、作業机を押し出さないこと
 * - 同じ発言の再送では、理由を二度返さないこと。完了の再送で「宣言が無い」と返さないこと
 * - 押し出し・送信の失敗は投げずに収集の失敗として残すこと（Twitch に再送させると二重に返信するため）
 * - モデレーションで消された宣言を作業机から外して押し出すこと
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage } from './chat-command'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeDatabase } from './fake-database'
import { listFailures } from './stats-store'
import { MAX_TASK_LENGTH } from './task-desk'
import { applyModerationToTaskDesk, handleTaskDeskCommand, type TaskDeskCommandContext } from './task-desk-command'

const STARTED_AT = '2026-10-03T12:00:00.000Z'
const NOW = Date.parse('2026-10-03T12:30:00.000Z')

let db: ReturnType<typeof createFakeDatabase>
let alertChannel: ReturnType<typeof createFakeAlertChannel>
/** botの名前で送った文言 */
let sentReplies: string[]

const startStream = (): void => {
  db.sqlite
    .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
    .run('今日の配信', STARTED_AT, '作業配信', 'Software and Game Development')
}

/** botを接続している状態の文脈。replyFails なら送信が失敗する */
const contextOf = ({ replyFails = false, botConnected = true, now = NOW } = {}): TaskDeskCommandContext => ({
  db,
  alerts: alertChannel.namespace,
  now,
  reply: botConnected
    ? async (text) => {
        if (replyFails) throw new Error('Twitch がチャットの送信を受け付けませんでした')
        sentReplies.push(text)
      }
    : null,
})

/** 視聴者「たなか」の発言 */
const chatOf = (text: string, messageId = 'chat-message-1'): ChatMessage => ({
  broadcasterUserId: '12345',
  messageId,
  chatterUserId: '11111',
  chatterUserLogin: 'tanaka',
  chatterUserName: 'たなか',
  text,
  badges: [],
})

beforeEach(() => {
  db = createFakeDatabase()
  alertChannel = createFakeAlertChannel()
  sentReplies = []
})

describe('handleTaskDeskCommand', () => {
  it('!task で宣言したら、いまの作業机を押し出し、botは何も返さない', async () => {
    startStream()

    expect(await handleTaskDeskCommand(contextOf(), chatOf('!task 英単語を50個覚える'))).toBe(true)

    expect(alertChannel.pushedTaskDesk).toEqual([
      {
        entries: [{ userId: '11111', name: 'たなか', task: '英単語を50個覚える', declaredAt: new Date(NOW).toISOString(), doneAt: null }],
        // 宣言した直後なので、合計はまだ0分で1人が作業中
        workTime: { people: 1, totalMs: 0, working: 1, measuredAt: new Date(NOW).toISOString() },
      },
    ])
    expect(sentReplies).toEqual([])
  })

  it('!done で完了したら、完了の時刻つきの作業机を押し出す', async () => {
    startStream()
    await handleTaskDeskCommand(contextOf(), chatOf('!task 英単語を50個覚える', 'chat-message-1'))

    await handleTaskDeskCommand(contextOf({ now: NOW + 60000 }), chatOf('!done', 'chat-message-2'))

    expect(alertChannel.pushedTaskDesk.at(-1)?.entries[0]?.doneAt).toBe(new Date(NOW + 60000).toISOString())
  })

  it('組み込みのコマンドでない発言は false を返し、何もしない', async () => {
    startStream()

    expect(await handleTaskDeskCommand(contextOf(), chatOf('こんにちは'))).toBe(false)

    expect(alertChannel.pushedTaskDesk).toEqual([])
    expect(sentReplies).toEqual([])
  })

  it('作業が長すぎれば、切り詰めずに受け付けず、botが理由を返す', async () => {
    startStream()

    await handleTaskDeskCommand(contextOf(), chatOf(`!task ${'あ'.repeat(MAX_TASK_LENGTH + 1)}`))

    expect(alertChannel.pushedTaskDesk).toEqual([])
    expect(sentReplies).toEqual([`@tanaka 作業は${MAX_TASK_LENGTH}文字以内で書いてください（いまは${MAX_TASK_LENGTH + 1}文字です）`])
  })

  it('配信していなければ、宣言を残さず、botが配信中だけ使えると返す', async () => {
    await handleTaskDeskCommand(contextOf(), chatOf('!task 英単語を50個覚える'))

    expect(alertChannel.pushedTaskDesk).toEqual([])
    expect(sentReplies).toEqual(['@tanaka 作業机は配信中だけ使えます'])
  })

  it('宣言せずに !done を打てば、botが宣言のしかたを返す', async () => {
    startStream()

    await handleTaskDeskCommand(contextOf(), chatOf('!done'))

    expect(sentReplies).toEqual(['@tanaka 完了にする作業がありません。!task 作業の内容 で宣言してください'])
  })

  it('もう完了しているのに !done を打っても、何も返さず押し出しもしない', async () => {
    startStream()
    await handleTaskDeskCommand(contextOf(), chatOf('!task 英単語を50個覚える', 'chat-message-1'))
    await handleTaskDeskCommand(contextOf(), chatOf('!done', 'chat-message-2'))
    const pushedBefore = alertChannel.pushedTaskDesk.length

    await handleTaskDeskCommand(contextOf(), chatOf('!done', 'chat-message-3'))

    expect(alertChannel.pushedTaskDesk).toHaveLength(pushedBefore)
    expect(sentReplies).toEqual([])
  })

  it('同じ発言が再送されても、理由を二度返さない', async () => {
    await handleTaskDeskCommand(contextOf(), chatOf('!task 英単語を50個覚える'))

    await handleTaskDeskCommand(contextOf(), chatOf('!task 英単語を50個覚える'))

    expect(sentReplies).toHaveLength(1)
  })

  it('botを接続していなくても宣言は残して押し出す（理由だけは返せない）', async () => {
    startStream()

    expect(await handleTaskDeskCommand(contextOf({ botConnected: false }), chatOf('!task 英単語を50個覚える'))).toBe(true)

    expect(alertChannel.pushedTaskDesk).toHaveLength(1)
  })

  it('押し出しに失敗しても投げず、収集の失敗として残す', async () => {
    startStream()
    alertChannel = createFakeAlertChannel({ shouldFail: true })

    await handleTaskDeskCommand(contextOf(), chatOf('!task 英単語を50個覚える'))

    expect((await listFailures(db)).map((failure) => failure.code)).toEqual(['task-desk-push-failed'])
  })

  it('理由の送信に失敗しても投げず、収集の失敗として残す', async () => {
    await handleTaskDeskCommand(contextOf({ replyFails: true }), chatOf('!task 英単語を50個覚える'))

    expect((await listFailures(db)).map((failure) => failure.code)).toEqual(['chat-reply-failed'])
  })
})

describe('applyModerationToTaskDesk', () => {
  it('宣言の発言が消されたら、その宣言を外した作業机を押し出す', async () => {
    startStream()
    await handleTaskDeskCommand(contextOf(), chatOf('!task 見せたくない文言', 'chat-message-arashi'))

    await applyModerationToTaskDesk(contextOf(), 'channel.chat.message_delete', {
      broadcaster_user_id: '12345',
      target_user_id: '11111',
      target_user_login: 'tanaka',
      target_user_name: 'たなか',
      message_id: 'chat-message-arashi',
    })

    expect(alertChannel.pushedTaskDesk.at(-1)).toEqual({ entries: [], workTime: null })
  })

  it('その人の発言がすべて消されたら（BAN・タイムアウト）、その人の宣言を外した作業机を押し出す', async () => {
    startStream()
    await handleTaskDeskCommand(contextOf(), chatOf('!task 見せたくない文言'))

    await applyModerationToTaskDesk(contextOf(), 'channel.chat.clear_user_messages', {
      broadcaster_user_id: '12345',
      target_user_id: '11111',
      target_user_login: 'tanaka',
      target_user_name: 'たなか',
    })

    expect(alertChannel.pushedTaskDesk.at(-1)).toEqual({ entries: [], workTime: null })
  })

  it('消された発言が宣言でなければ、押し出さない（作業机が変わらないのに配らない）', async () => {
    startStream()
    await handleTaskDeskCommand(contextOf(), chatOf('!task 英単語を50個覚える'))
    const pushedBefore = alertChannel.pushedTaskDesk.length

    await applyModerationToTaskDesk(contextOf(), 'channel.chat.message_delete', {
      broadcaster_user_id: '12345',
      target_user_id: '11111',
      target_user_login: 'tanaka',
      target_user_name: 'たなか',
      message_id: 'ふつうの発言',
    })

    expect(alertChannel.pushedTaskDesk).toHaveLength(pushedBefore)
  })

  it('削除の通知でなければ何もしない', async () => {
    startStream()

    await applyModerationToTaskDesk(contextOf(), 'channel.chat.notification', { broadcaster_user_id: '12345' })

    expect(alertChannel.pushedTaskDesk).toEqual([])
  })
})
