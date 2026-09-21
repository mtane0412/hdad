/**
 * デモ用のサンプル（?demo=true）
 *
 * OBSでの配置を調整するために、Twitchにも Worker にも接続せず、サンプルの交換をサンプル画像で表示する。
 * 画像はこのリポジトリで描いたもので、再配布の制限はない。
 */
import type { EventSubNotification } from './eventsub'
import sampleImageUrl from './sample.svg'
import type { AlertTrigger } from './trigger'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'

export const demoTriggers: readonly AlertTrigger[] = [
  {
    event: REDEMPTION,
    rewardId: null,
    media: { kind: 'image', url: sampleImageUrl },
    durationSeconds: 6,
    volume: 1,
    message: '{user} さんが「{reward}」を交換しました',
  },
]

export const demoNotification: EventSubNotification = {
  type: 'notification',
  id: 'demo',
  subscriptionType: REDEMPTION,
  event: { user_name: 'たねのぶ', user_input: '', reward: { id: 'demo-reward', title: '水を飲む' } },
}
