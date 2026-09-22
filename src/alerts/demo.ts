/**
 * デモ用のサンプル（?demo=true）
 *
 * OBSでの配置を調整するために、Twitchにも Worker にも接続せず、サンプルの通知をサンプル画像で表示する。
 * 対応している5種類のイベント（チャンネルポイント交換・フォロー・サブスク・継続サブスク・レイド）を順に出し、
 * イベントごとの差し込み語がどう見えるかを確かめられるようにする。
 * 画像はこのリポジトリで描いたもので、再配布の制限はない。
 */
import type { EventSubNotification } from './eventsub'
import sampleImageUrl from './sample.svg'
import type { AlertTrigger } from './trigger'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'

/** サンプルの出し方。イベント種別によらず同じ素材・表示時間・音量で、条件は付けない（サンプルの通知に必ず当てる） */
const 出し方 = { media: { kind: 'image', url: sampleImageUrl }, durationSeconds: 6, volume: 1, conditions: [] } as const

export const demoTriggers: readonly AlertTrigger[] = [
  { ...出し方, event: REDEMPTION, message: '{user} さんが「{reward}」を交換しました' },
  { ...出し方, event: 'channel.follow', message: '{user} さんがフォローしました' },
  { ...出し方, event: 'channel.subscribe', message: '{user} さんがティア{tier}でサブスクしました' },
  { ...出し方, event: 'channel.subscription.message', message: '{user} さんが{months}か月目のサブスク（ティア{tier}）' },
  { ...出し方, event: 'channel.raid', message: '{user} さんが{viewers}人でレイドしました' },
]

const 通知 = (subscriptionType: string, event: Record<string, unknown>): EventSubNotification => ({
  type: 'notification',
  id: `demo-${subscriptionType}`,
  subscriptionType,
  event,
})

/** サンプルの通知。demoTriggers と同じ並びで、順に1件ずつ出す */
export const demoNotifications: readonly EventSubNotification[] = [
  通知(REDEMPTION, { user_name: 'たねのぶ', user_login: 'tanenobu', user_input: '', reward: { id: 'demo-reward', title: '水を飲む' } }),
  通知('channel.follow', { user_name: 'たねのぶ', user_login: 'tanenobu', followed_at: '2026-09-21T10:00:00Z' }),
  通知('channel.subscribe', { user_name: 'たねのぶ', user_login: 'tanenobu', tier: '1000', is_gift: false }),
  通知('channel.subscription.message', { user_name: 'たねのぶ', user_login: 'tanenobu', tier: '2000', cumulative_months: 12, streak_months: 3 }),
  通知('channel.raid', { from_broadcaster_user_name: 'たねのぶ', from_broadcaster_user_login: 'tanenobu', viewers: 42 }),
]
