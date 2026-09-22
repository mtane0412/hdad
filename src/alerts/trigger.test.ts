/**
 * トリガーの照合（trigger.ts）のテスト
 *
 * 届いた通知を設定（トリガーの一覧）と照らし合わせ、画面に出すアラートへ変換できることを確認する。
 * 購読している5種類のイベント（チャンネルポイント交換・フォロー・サブスク・継続サブスク・レイド）それぞれについて、
 * 項目の取り出し・条件の照合・文言の差し込みを確かめる。
 */
import { describe, expect, it } from 'vitest'
import type { EventSubNotification } from './eventsub'
import { extract, fillMessage, matches, toAlert, type AlertCondition, type AlertTrigger, type Extracted } from './trigger'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
const FOLLOW = 'channel.follow'
const SUBSCRIBE = 'channel.subscribe'
const SUBSCRIPTION_MESSAGE = 'channel.subscription.message'
const RAID = 'channel.raid'

/** 出し方（イベント種別によらず共通）の既定値。テストでは条件だけを重ねて書く */
const 出し方 = {
  media: { kind: 'image', url: 'https://example.com/kanpai.png' },
  durationSeconds: 5,
  volume: 0.8,
  message: '',
} as const

const 通知 = (subscriptionType: string, event: Record<string, unknown>): EventSubNotification => ({
  type: 'notification',
  id: `メッセージID-${subscriptionType}`,
  subscriptionType,
  event,
})

const 交換の通知 = (rewardId: string, rewardTitle: string): EventSubNotification =>
  通知(REDEMPTION, { user_name: 'たねのぶ', user_login: 'tanenobu', user_input: '', reward: { id: rewardId, title: rewardTitle, cost: 100 } })

const フォローの通知 = 通知(FOLLOW, { user_name: 'たねのぶ', user_login: 'tanenobu', followed_at: '2026-09-21T10:00:00Z' })
const サブスクの通知 = 通知(SUBSCRIBE, { user_name: 'たねのぶ', user_login: 'tanenobu', tier: '2000', is_gift: false })
const 継続サブスクの通知 = 通知(SUBSCRIPTION_MESSAGE, { user_name: 'たねのぶ', user_login: 'tanenobu', tier: '1000', cumulative_months: 12, streak_months: 3 })
const レイドの通知 = 通知(RAID, { from_broadcaster_user_name: 'たねのぶ', from_broadcaster_user_login: 'tanenobu', viewers: 42 })

describe('extract', () => {
  it('チャンネルポイント交換の通知から、交換した人・報酬ID・報酬名を取り出す', () => {
    expect(extract(交換の通知('報酬ID-水', '水を飲む'))).toEqual({
      event: REDEMPTION,
      userName: 'たねのぶ',
      userLogin: 'tanenobu',
      rewardId: '報酬ID-水',
      rewardTitle: '水を飲む',
    })
  })

  it('フォローの通知から、フォローした人を取り出す', () => {
    expect(extract(フォローの通知)).toEqual({ event: FOLLOW, userName: 'たねのぶ', userLogin: 'tanenobu' })
  })

  it('サブスク（新規）の通知から、サブスクした人とティアを取り出す', () => {
    expect(extract(サブスクの通知)).toEqual({ event: SUBSCRIBE, userName: 'たねのぶ', userLogin: 'tanenobu', tier: '2000' })
  })

  it('サブスク（継続メッセージ）の通知から、人・ティア・累計月数を取り出す', () => {
    expect(extract(継続サブスクの通知)).toEqual({ event: SUBSCRIPTION_MESSAGE, userName: 'たねのぶ', userLogin: 'tanenobu', tier: '1000', cumulativeMonths: 12 })
  })

  it('レイドの通知から、レイドした配信者と人数を取り出す（レイドは from_broadcaster_user_name に入る）', () => {
    expect(extract(レイドの通知)).toEqual({ event: RAID, userName: 'たねのぶ', userLogin: 'tanenobu', viewers: 42 })
  })

  it('知らない種類のイベントは null を返す（Twitchがイベントを増やしてもオーバーレイを止めない）', () => {
    expect(extract(通知('channel.cheer', { user_name: 'たねのぶ', bits: 100 }))).toBeNull()
  })

  it.each([
    ['チャンネルポイント交換', 通知(REDEMPTION, { user_name: 'たねのぶ', user_login: 'tanenobu' }), 'reward'],
    ['フォロー', 通知(FOLLOW, {}), 'user_name'],
    ['サブスク（新規）', 通知(SUBSCRIBE, { user_name: 'たねのぶ', user_login: 'tanenobu' }), 'tier'],
    ['サブスク（継続メッセージ）', 通知(SUBSCRIPTION_MESSAGE, { user_name: 'たねのぶ', user_login: 'tanenobu', tier: '1000' }), 'cumulative_months'],
    ['レイド', 通知(RAID, { from_broadcaster_user_name: 'たねのぶ', from_broadcaster_user_login: 'tanenobu' }), 'viewers'],
  ])('%s の通知に必要な項目がなければエラーにする', (_名前, broken, 欠けた項目) => {
    expect(() => extract(broken)).toThrow(欠けた項目)
  })
})

describe('matches', () => {
  const 交換 = { event: REDEMPTION, userName: 'たねのぶ', userLogin: 'tanenobu', rewardId: '報酬ID-乾杯', rewardTitle: '乾杯する' } as const satisfies Extracted
  /** チャンネルポイント交換のトリガー。条件だけを差し替えて確かめる */
  const 交換のトリガー = (conditions: AlertCondition[]): AlertTrigger => ({ ...出し方, event: REDEMPTION, conditions })

  it('イベント種別が違うトリガーには当てはまらない', () => {
    expect(matches({ ...出し方, event: FOLLOW, conditions: [] }, 交換)).toBe(false)
  })

  it('条件を1件も持たないトリガーは、イベント種別が同じなら当てはまる', () => {
    expect(matches(交換のトリガー([]), 交換)).toBe(true)
    expect(matches({ ...出し方, event: RAID, conditions: [] }, { event: RAID, userName: 'たねのぶ', userLogin: 'tanenobu', viewers: 42 })).toBe(true)
  })

  it('reward の条件は、その報酬の交換にだけ当てはまる', () => {
    expect(matches(交換のトリガー([{ kind: 'reward', rewardId: '報酬ID-乾杯' }]), 交換)).toBe(true)
    expect(matches(交換のトリガー([{ kind: 'reward', rewardId: '報酬ID-水' }]), 交換)).toBe(false)
  })

  it('user の条件は、相手のユーザー名が同じときだけ当てはまる（大文字小文字は区別しない）', () => {
    expect(matches(交換のトリガー([{ kind: 'user', login: 'tanenobu' }]), 交換)).toBe(true)
    expect(matches(交換のトリガー([{ kind: 'user', login: 'TaneNobu' }]), 交換)).toBe(true)
    expect(matches(交換のトリガー([{ kind: 'user', login: 'hanako' }]), 交換)).toBe(false)
  })

  it('条件が2つあれば、すべてを満たしたときだけ当てはまる（and）', () => {
    const 両方合う: AlertCondition[] = [
      { kind: 'reward', rewardId: '報酬ID-乾杯' },
      { kind: 'user', login: 'tanenobu' },
    ]
    const ユーザーだけ違う: AlertCondition[] = [
      { kind: 'reward', rewardId: '報酬ID-乾杯' },
      { kind: 'user', login: 'hanako' },
    ]

    expect(matches(交換のトリガー(両方合う), 交換)).toBe(true)
    expect(matches(交換のトリガー(ユーザーだけ違う), 交換)).toBe(false)
  })

  it('reward の条件はチャンネルポイント交換以外には当てはまらない', () => {
    const フォローに報酬: AlertTrigger = { ...出し方, event: FOLLOW, conditions: [{ kind: 'reward', rewardId: '報酬ID-乾杯' }] }

    expect(matches(フォローに報酬, { event: FOLLOW, userName: 'たねのぶ', userLogin: 'tanenobu' })).toBe(false)
  })
})

describe('fillMessage', () => {
  it('チャンネルポイント交換では {user} と {reward} を差し込む', () => {
    const 交換: Extracted = { event: REDEMPTION, userName: 'たねのぶ', userLogin: 'tanenobu', rewardId: '報酬ID-水', rewardTitle: '水を飲む' }
    expect(fillMessage('{user} さんが「{reward}」を交換しました', 交換)).toBe('たねのぶ さんが「水を飲む」を交換しました')
  })

  it('フォローでは {user} を差し込む', () => {
    expect(fillMessage('{user} さんがフォローしました', { event: FOLLOW, userName: 'たねのぶ', userLogin: 'tanenobu' })).toBe('たねのぶ さんがフォローしました')
  })

  it('サブスク（新規）では {tier} を 1・2・3 に直して差し込む', () => {
    expect(fillMessage('{user} さんがティア{tier}でサブスクしました', { event: SUBSCRIBE, userName: 'たねのぶ', userLogin: 'tanenobu', tier: '2000' })).toBe(
      'たねのぶ さんがティア2でサブスクしました',
    )
  })

  it('サブスク（継続メッセージ）では {months} に累計月数を差し込む', () => {
    const 継続: Extracted = { event: SUBSCRIPTION_MESSAGE, userName: 'たねのぶ', userLogin: 'tanenobu', tier: '1000', cumulativeMonths: 12 }
    expect(fillMessage('{user} さんが{months}か月目のサブスク（ティア{tier}）', 継続)).toBe('たねのぶ さんが12か月目のサブスク（ティア1）')
  })

  it('レイドでは {viewers} に人数を差し込む', () => {
    expect(fillMessage('{user} さんが{viewers}人でレイドしました', { event: RAID, userName: 'たねのぶ', userLogin: 'tanenobu', viewers: 42 })).toBe(
      'たねのぶ さんが42人でレイドしました',
    )
  })

  it('差し込む値に $ を含む文字列（報酬名など）が来ても、そのまま差し込む', () => {
    const 交換: Extracted = { event: REDEMPTION, userName: 'たねのぶ', userLogin: 'tanenobu', rewardId: '報酬ID-投げ銭', rewardTitle: '$&ボーナス' }
    expect(fillMessage('「{reward}」を交換しました', 交換)).toBe('「$&ボーナス」を交換しました')
  })

  it('そのイベントに存在しない差し込み語は置き換えず、そのまま残す（配信者が入力の誤りに気付けるようにする）', () => {
    expect(fillMessage('{user}／{reward}', { event: FOLLOW, userName: 'たねのぶ', userLogin: 'tanenobu' })).toBe('たねのぶ／{reward}')
  })
})

describe('toAlert', () => {
  it('当てはまるトリガーを見つけ、文言を差し込んだアラートにする', () => {
    const triggers: AlertTrigger[] = [{ ...出し方, event: REDEMPTION, conditions: [], message: '{user} さんが「{reward}」を交換しました' }]

    expect(toAlert(triggers, 交換の通知('報酬ID-水', '水を飲む'))).toEqual({
      media: { kind: 'image', url: 'https://example.com/kanpai.png' },
      durationSeconds: 5,
      volume: 0.8,
      text: 'たねのぶ さんが「水を飲む」を交換しました',
    })
  })

  it.each([
    [FOLLOW, フォローの通知, '{user} さんがフォローしました', 'たねのぶ さんがフォローしました'],
    [SUBSCRIBE, サブスクの通知, '{user} さんがティア{tier}でサブスク', 'たねのぶ さんがティア2でサブスク'],
    [SUBSCRIPTION_MESSAGE, 継続サブスクの通知, '{user} さん{months}か月目', 'たねのぶ さん12か月目'],
    [RAID, レイドの通知, '{user} さんが{viewers}人でレイド', 'たねのぶ さんが42人でレイド'],
  ])('%s のトリガーでもアラートを出す', (event, notification, message, expected) => {
    const trigger = { ...出し方, event, conditions: [], message } as AlertTrigger
    expect(toAlert([trigger], notification)?.text).toBe(expected)
  })

  it('複数のトリガーが当てはまる場合は、先に書かれたものを使う（報酬を指定したものを先に書けば優先できる）', () => {
    const triggers: AlertTrigger[] = [
      { ...出し方, event: REDEMPTION, conditions: [{ kind: 'reward', rewardId: '報酬ID-乾杯' }], message: '乾杯！' },
      { ...出し方, event: REDEMPTION, conditions: [], message: 'その他の報酬' },
    ]
    expect(toAlert(triggers, 交換の通知('報酬ID-乾杯', '乾杯する'))?.text).toBe('乾杯！')
    expect(toAlert(triggers, 交換の通知('報酬ID-水', '水を飲む'))?.text).toBe('その他の報酬')
  })

  it('トリガーを設定していないイベントは null を返す', () => {
    const triggers: AlertTrigger[] = [{ ...出し方, event: REDEMPTION, conditions: [] }]
    expect(toAlert(triggers, フォローの通知)).toBeNull()
  })

  it('知らない種類のイベントは null を返す', () => {
    const triggers: AlertTrigger[] = [{ ...出し方, event: REDEMPTION, conditions: [] }]
    expect(toAlert(triggers, 通知('channel.cheer', { user_name: 'たねのぶ', bits: 100 }))).toBeNull()
  })

  it('交換の通知に報酬の情報がなければエラーにする', () => {
    const triggers: AlertTrigger[] = [{ ...出し方, event: REDEMPTION, conditions: [] }]
    expect(() => toAlert(triggers, 通知(REDEMPTION, { user_name: 'たねのぶ', user_login: 'tanenobu' }))).toThrow('reward')
  })
})
