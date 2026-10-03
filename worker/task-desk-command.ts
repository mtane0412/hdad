/**
 * 作業机の組み込みコマンドの実行と、モデレーションの反映
 *
 * チャットの受け口（worker/webhook-routes.ts）から呼ばれ、視聴者の !task・!done を作業机（task_declarations）に書き、
 * 変わったらいまの作業机を合成ページへ丸ごと押し出す（issue #207）。受け付けないときは bot が理由を返す（方針4）。
 * モデレーションで発言が消されたときは、その発言に当たる宣言を作業机から外して押し出し直す（荒らしの文言を配信画面に残さない）。
 *
 * 何を読み取るか・何を返すかは worker/task-desk.ts、読み書きは worker/task-desk-store.ts が持ち、ここはそれらを順につなぐだけである。
 *
 * 注意: 押し出しと返信の失敗は投げずに収集の失敗として残す。投げると Twitch が同じ通知を再送し、返信が二重になるため
 * （登録したコマンドの応答と同じ扱い）。作業机は合成ページが定期的に読み直すので、押し出しの失敗はそこで取り戻せる。
 */
import { pushTaskDesk, type AlertChannelNamespace } from './alert-channel'
import type { ChatMessage } from './chat-command'
import { reserveChatReply } from './chat-store'
import { CHAT_CLEAR, CHAT_CLEAR_USER_MESSAGES, CHAT_MESSAGE_DELETE, toFeedItem } from './comment-feed'
import type { Database } from './database'
import { recordFailure } from './stats-store'
import { readTaskDeskCommand, refusalReply, TASK_DESK_LIMIT, type TaskDeskRefusal } from './task-desk'
import { completeTask, declareTask, readTaskDesk, removeModeratedTasks } from './task-desk-store'

/** 作業机の組み込みコマンドを実行するのに要るもの */
export interface TaskDeskCommandContext {
  readonly db: Database
  readonly alerts: AlertChannelNamespace
  readonly now: number
  /**
   * bot の名前でチャットへ1通送る。bot を接続していなければ null で、そのときも宣言は残して押し出す
   * （作業机に並べるのに bot は要らない）。受け付けない理由だけは返せない
   */
  readonly reply: ((text: string) => Promise<void>) | null
}

/** モデレーションの削除で作業机を変える通知の種類 */
const MODERATION_EVENT_TYPES: readonly string[] = [CHAT_MESSAGE_DELETE, CHAT_CLEAR_USER_MESSAGES, CHAT_CLEAR]

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** いまの作業机を読み、合成ページへ押し出す。失敗は収集の失敗として残す */
const pushCurrentDesk = async ({ db, alerts, now }: TaskDeskCommandContext): Promise<void> => {
  try {
    await pushTaskDesk(alerts, { entries: await readTaskDesk(db, now, TASK_DESK_LIMIT) })
  } catch (error) {
    await recordFailure(db, 'task-desk-push-failed', messageOf(error), now)
  }
}

/**
 * 受け付けない理由を bot から返す。
 *
 * 鍵に動作の種類を混ぜるのは、同じ発言で自動モデレーションやトリガーの送信と鍵を取り合わないため（webhook-routes.ts と同じ）。
 * 同じ発言の再送では鍵が取れないので、二度返さない。
 */
const replyRefusal = async (context: TaskDeskCommandContext, message: ChatMessage, refusal: TaskDeskRefusal): Promise<void> => {
  const { db, now, reply } = context
  if (reply === null) return
  if (!(await reserveChatReply(db, `${message.messageId}:taskDesk`, now))) return
  try {
    await reply(refusalReply(refusal, message.chatterUserLogin))
  } catch (error) {
    await recordFailure(db, 'chat-reply-failed', messageOf(error), now)
  }
}

/**
 * 発言が組み込みのコマンド（!task・!done）なら実行する。
 *
 * 呼び出し側は、自動モデレーションで処分した発言と bot 自身の発言をここへ渡さない。
 *
 * @returns 組み込みのコマンドだったなら true（登録したコマンドの判定へは進ませない）
 */
export const handleTaskDeskCommand = async (context: TaskDeskCommandContext, message: ChatMessage): Promise<boolean> => {
  const { db, now } = context
  const command = readTaskDeskCommand(message.text)
  if (command === null) return false

  switch (command.kind) {
    case 'refuse':
      await replyRefusal(context, message, command.refusal)
      break
    case 'declare': {
      const declaration = { userId: message.chatterUserId, name: message.chatterUserName, task: command.task, messageId: message.messageId }
      if (await declareTask(db, declaration, now)) await pushCurrentDesk(context)
      else await replyRefusal(context, message, { kind: 'offline' })
      break
    }
    case 'complete': {
      const result = await completeTask(db, { userId: message.chatterUserId, messageId: message.messageId }, now)
      if (result === 'completed') await pushCurrentDesk(context)
      else if (result === 'offline' || result === 'no-task') await replyRefusal(context, message, { kind: result })
      // already-done（もう完了している・処理済みの !done の再送）は、作業机が変わらないので何もしない
      break
    }
  }
  return true
}

/**
 * モデレーションの削除の通知（発言の削除・ある人の発言の一掃・チャットのクリア）を作業机に反映する。
 *
 * 当たる宣言があれば作業机から消して押し出し直す。ほかの種類の通知では何もしない。
 * 通知の読み取りはコメントビューアーと同じ toFeedItem を使う（同じ通知を2か所で読み解かない）。
 *
 * 注意: 失敗は投げずに収集の失敗として残す（コメントビューアーへの配送と同じく、Twitch に再送させない）。
 */
export const applyModerationToTaskDesk = async (context: Omit<TaskDeskCommandContext, 'reply'>, type: string, event: unknown): Promise<void> => {
  if (!MODERATION_EVENT_TYPES.includes(type)) return
  const { db, now } = context
  try {
    // 目印（id・at）は作業机では使わないので、読み取りのためだけに埋める
    const item = toFeedItem(type, event, { id: '', at: now }, false)
    if (item === null || (item.kind !== 'delete' && item.kind !== 'clearUser' && item.kind !== 'clear')) return
    if (await removeModeratedTasks(db, item, now)) await pushCurrentDesk({ ...context, reply: null })
  } catch (error) {
    await recordFailure(db, 'task-desk-moderation-failed', messageOf(error), now)
  }
}
