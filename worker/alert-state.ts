/**
 * 状態を持つ条件の判定
 *
 * トリガーの条件のうち、通知の中身だけでは決まらないもの（いまは「その配信で初めての発言か」だけ）を、
 * データベースを見て先に決める。照合そのもの（alert-event.ts の matches）は通信も時刻も持たない純粋な関数のままにしておき、
 * ここで決めた結果を値として渡す（chat-moderation.ts の judge が連投の件数を引数で受け取っているのと同じ作り）。
 *
 * この判定はWebhook（worker/webhook-routes.ts のチャット・アナウンスの送信）とオーバーレイ（POST /api/overlay/alert の素材の再生）の
 * 両方から呼ばれる。同じ発言について何度呼んでも同じ答えを返す必要があるため、記録の側（chat-store.ts の
 * claimFirstChatOfStream）が発言のIDを持って冪等にしている。
 *
 * 注意: 条件を使うトリガーが1件もないときはデータベースを触らない。チャットは件数の桁が違い、
 * 1通ごとに書くと配信の記録とD1の書き込みの枠を食い合う。
 */
import type { AlertConfig } from './alert-config'
import { requiresFirstChatOfStream, type ConditionState } from './alert-event'
import type { ChatMessage } from './chat-command'
import { claimFirstChatOfStream } from './chat-store'
import type { Database } from './database'

const CHAT_MESSAGE = 'channel.chat.message'

/**
 * 通知の中身だけでは決まらない条件の判定結果をそろえる。
 *
 * @param message 通知がチャットの発言なら、読み取った発言。ほかのイベントなら null
 *   （読み取りを呼び出し側に任せるのは、同じ通知を2か所で読み解かないため）
 * @returns 照合（alert-event.ts の matches・chatMessageFor・announcementFor・alertFor）に渡す判定結果
 */
export const resolveConditionState = async (db: Database, config: AlertConfig, message: ChatMessage | null, now: number): Promise<ConditionState> => {
  // 発言以外のイベントでは「その配信で初めての発言」は意味を持たない
  if (message === null || !requiresFirstChatOfStream(config, CHAT_MESSAGE)) return { firstChatOfStream: false }

  const firstChatOfStream = await claimFirstChatOfStream(db, { chatterUserId: message.chatterUserId, messageId: message.messageId }, now)
  return { firstChatOfStream }
}
