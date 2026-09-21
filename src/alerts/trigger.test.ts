/**
 * トリガーの照合（trigger.ts）のテスト
 *
 * 届いた通知を設定（トリガーの一覧）と照らし合わせ、画面に出すアラートへ変換できることを確認する。
 */
import { describe, expect, it } from 'vitest'
import type { EventSubNotification } from './eventsub'
import { toAlert, type AlertTrigger } from './trigger'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'

const トリガー = (overrides: Partial<AlertTrigger> = {}): AlertTrigger => ({
  event: REDEMPTION,
  rewardId: null,
  media: { kind: 'image', url: 'https://example.com/kanpai.png' },
  durationSeconds: 5,
  volume: 0.8,
  message: '{user} さんが「{reward}」を交換しました',
  ...overrides,
})

const 交換の通知 = (rewardId: string, rewardTitle: string): EventSubNotification => ({
  type: 'notification',
  id: 'メッセージID-1',
  subscriptionType: REDEMPTION,
  event: { user_name: 'たねのぶ', user_input: '', reward: { id: rewardId, title: rewardTitle, cost: 100 } },
})

describe('toAlert', () => {
  it('報酬IDを指定しないトリガーは、どの報酬の交換にも反応する', () => {
    expect(toAlert([トリガー()], 交換の通知('報酬ID-水', '水を飲む'))).toEqual({
      media: { kind: 'image', url: 'https://example.com/kanpai.png' },
      durationSeconds: 5,
      volume: 0.8,
      text: 'たねのぶ さんが「水を飲む」を交換しました',
    })
  })

  it('報酬IDを指定したトリガーは、その報酬の交換にだけ反応する', () => {
    const triggers = [トリガー({ rewardId: '報酬ID-乾杯' })]
    expect(toAlert(triggers, 交換の通知('報酬ID-水', '水を飲む'))).toBeNull()
    expect(toAlert(triggers, 交換の通知('報酬ID-乾杯', '乾杯する'))?.text).toBe('たねのぶ さんが「乾杯する」を交換しました')
  })

  it('複数のトリガーが当てはまる場合は、先に書かれたものを使う（報酬を指定したものを先に書けば優先できる）', () => {
    const triggers = [
      トリガー({ rewardId: '報酬ID-乾杯', message: '乾杯！' }),
      トリガー({ rewardId: null, message: 'その他の報酬' }),
    ]
    expect(toAlert(triggers, 交換の通知('報酬ID-乾杯', '乾杯する'))?.text).toBe('乾杯！')
    expect(toAlert(triggers, 交換の通知('報酬ID-水', '水を飲む'))?.text).toBe('その他の報酬')
  })

  it('トリガーにない種類のイベントは null を返す（フォローなど、まだ設定していないイベント）', () => {
    const follow: EventSubNotification = { type: 'notification', id: 'メッセージID-2', subscriptionType: 'channel.follow', event: { user_name: 'たねのぶ' } }
    expect(toAlert([トリガー()], follow)).toBeNull()
  })

  it('交換の通知に報酬の情報がなければエラーにする', () => {
    const broken: EventSubNotification = { type: 'notification', id: 'メッセージID-3', subscriptionType: REDEMPTION, event: { user_name: 'たねのぶ' } }
    expect(() => toAlert([トリガー()], broken)).toThrow('reward')
  })
})
