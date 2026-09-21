/**
 * トリガーの照合
 *
 * トリガーは「どのイベントで、どの素材を、どう出すか」の設定1件。届いた通知をトリガーの一覧と照らし合わせ、
 * 画面に出すアラート（素材・表示時間・音量・文言）へ変換する。
 * いま対応しているイベントはチャンネルポイントの交換だけ。
 */
import type { EventSubNotification } from './eventsub'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'

/** 再生する素材。image は静止画・アニメーション画像、audio は音だけ */
export interface AlertMedia {
  readonly kind: 'image' | 'video' | 'audio'
  readonly url: string
}

export interface AlertTrigger {
  readonly event: typeof REDEMPTION
  /** 対象の報酬ID。null はすべての報酬 */
  readonly rewardId: string | null
  readonly media: AlertMedia
  /** 表示する秒数 */
  readonly durationSeconds: number
  /** 音量（0〜1）。動画と音声に使う */
  readonly volume: number
  /** 表示する文言。{user} は交換した人の表示名、{reward} は報酬名に置き換わる。空文字なら文言を出さない */
  readonly message: string
}

/** 画面に出すアラート1件 */
export interface Alert {
  readonly media: AlertMedia
  readonly durationSeconds: number
  readonly volume: number
  readonly text: string
}

/** チャンネルポイント交換の通知から、照合と文言に使う項目を取り出す */
const readRedemption = (event: Readonly<Record<string, unknown>>): { userName: string; rewardId: string; rewardTitle: string } => {
  const { user_name: userName, reward } = event
  if (typeof userName !== 'string' || typeof reward !== 'object' || reward === null) {
    throw new Error('チャンネルポイント交換の通知に user_name または reward がありません')
  }
  const { id, title } = reward as Record<string, unknown>
  if (typeof id !== 'string' || typeof title !== 'string') {
    throw new Error('チャンネルポイント交換の通知の reward に id または title がありません')
  }
  return { userName, rewardId: id, rewardTitle: title }
}

/**
 * 通知に当てはまるトリガーを探し、アラートへ変換する。
 *
 * @param triggers トリガーの一覧。複数が当てはまる場合は先に書かれたものを使う
 * @returns 当てはまるトリガーがなければ null
 * @throws 通知の中身が想定した形でない場合
 */
export const toAlert = (triggers: readonly AlertTrigger[], notification: EventSubNotification): Alert | null => {
  if (notification.subscriptionType !== REDEMPTION) return null

  const { userName, rewardId, rewardTitle } = readRedemption(notification.event)
  const trigger = triggers.find((candidate) => candidate.rewardId === null || candidate.rewardId === rewardId)
  if (!trigger) return null

  return {
    media: trigger.media,
    durationSeconds: trigger.durationSeconds,
    volume: trigger.volume,
    text: trigger.message.replaceAll('{user}', userName).replaceAll('{reward}', rewardTitle),
  }
}
