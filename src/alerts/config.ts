/**
 * アラートの設定（直書き）
 *
 * 管理画面ができるまでの仮の置き場所。すべてのチャンネルポイント交換で、サンプル画像と文言を表示する。
 * 管理画面の実装時に、Workerから取得した設定（報酬ごとの素材・表示時間・音量）へ差し替える。
 */
import sampleImageUrl from './sample.svg'
import type { AlertTrigger } from './trigger'

export const triggers: readonly AlertTrigger[] = [
  {
    event: 'channel.channel_points_custom_reward_redemption.add',
    rewardId: null,
    media: { kind: 'image', url: sampleImageUrl },
    durationSeconds: 6,
    volume: 1,
    message: '{user} さんが「{reward}」を交換しました',
  },
]
