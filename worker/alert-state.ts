/**
 * 状態を持つ条件の判定
 *
 * トリガーの条件のうち、通知の中身だけでは決まらないもの（その配信で初めての発言か・このチャンネルで初めての発言か・
 * 最後の発言から何日空いているか）を、データベースを見て先に決める。照合そのもの（alert-event.ts の matches）は通信も時刻も持たない純粋な関数のままにしておき、
 * ここで決めた結果を値として渡す（chat-moderation.ts の judge が連投の件数を引数で受け取っているのと同じ作り）。
 *
 * 呼ぶのはWebhookの受け口（worker/webhook-routes.ts）だけだが、Twitchは同じ通知を再送することがあるため、
 * 同じ発言について何度呼んでも同じ答えを返す必要がある。記録の側（chat-store.ts の claimFirstChatOfStream、
 * viewer-store.ts の readChatHistory）が発言のIDを持って冪等にしているのはこのためである。
 *
 * 注意: 条件を使うトリガーが1件もないときはデータベースを触らない。チャットは件数の桁が違い、
 * 1通ごとに書くと配信の記録とD1の書き込みの枠を食い合う。判定は種類ごとに要否を分けて調べる
 * （その配信の初回は first_chatters への書き込み、視聴者の記録は viewers の読み出しで、触る先が違う）。
 * 注意: 視聴者の記録を使う判定は、Webhookの受け口がその発言を記録した「あと」に呼ぶ前提で書いてある
 * （readChatHistory の注意を参照）。呼ぶ順序を入れ替えると、空いた日数が読めなくなる。
 */
import type { AlertConfig } from './alert-config'
import { requiresChatHistory, requiresFirstChatOfStream, type ConditionState } from './alert-event'
import type { ChatMessage } from './chat-command'
import { claimFirstChatOfStream } from './chat-store'
import type { Database } from './database'
import { readChatHistory, type ChatHistory } from './viewer-store'

const CHAT_MESSAGE = 'channel.chat.message'

/** どの判定も「当てはまらない」状態。発言以外のイベントで返す */
const NO_STATE: ConditionState = { firstChatOfStream: false, firstChatEver: false, daysSinceLastChat: null }

/** 視聴者の記録を読まなかったときの判定。記録を使う条件がないので、当てはまらない扱いでよい */
const NO_HISTORY: ChatHistory = { firstChatEver: false, daysSinceLastChat: null }

/**
 * 通知の中身だけでは決まらない条件の判定結果をそろえる。
 *
 * @param message 通知がチャットの発言なら、読み取った発言。ほかのイベントなら null
 *   （読み取りを呼び出し側に任せるのは、同じ通知を2か所で読み解かないため）
 * @returns 照合（alert-event.ts の matches・chatMessageFor・announcementFor・alertFor）に渡す判定結果
 */
export const resolveConditionState = async (db: Database, config: AlertConfig, message: ChatMessage | null, now: number): Promise<ConditionState> => {
  // 発言以外のイベントでは、どの判定も意味を持たない
  if (message === null) return NO_STATE

  const firstChatOfStream = requiresFirstChatOfStream(config, CHAT_MESSAGE)
    ? await claimFirstChatOfStream(db, { chatterUserId: message.chatterUserId, messageId: message.messageId }, now)
    : false
  const history = requiresChatHistory(config, CHAT_MESSAGE)
    ? await readChatHistory(db, { userId: message.chatterUserId, messageId: message.messageId }, now)
    : NO_HISTORY

  return { firstChatOfStream, ...history }
}
