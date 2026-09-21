/**
 * アラートのイベントの読み取り（alert-event.ts）のテスト
 *
 * Twitchから届いた通知の中身から、条件の照合と文言の差し込みに使う項目を取り出せること、
 * トリガーの一覧から「チャットに送る」動作を選べることを確認する。
 * オーバーレイ側（src/alerts/trigger.ts）と同じ役目のコードだが、worker/ は src/ を読み込まない約束のため別に持つ。
 */
import { describe, expect, it } from 'vitest'
import type { AlertConfig, StoredTrigger } from './alert-config'
import { chatMessageFor, extract, fillMessage, matches } from './alert-event'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'

describe('extract', () => {
  it('チャンネルポイント交換から、交換した人と報酬を取り出す', () => {
    const event = { user_name: '田中太郎', reward: { id: '報酬ID-乾杯', title: '乾杯する' } }

    expect(extract(REDEMPTION, event)).toEqual({ event: REDEMPTION, userName: '田中太郎', rewardId: '報酬ID-乾杯', rewardTitle: '乾杯する' })
  })

  it('フォローから、フォローした人を取り出す', () => {
    expect(extract('channel.follow', { user_name: '田中太郎' })).toEqual({ event: 'channel.follow', userName: '田中太郎' })
  })

  it('新規サブスクから、サブスクした人とティアを取り出す', () => {
    expect(extract('channel.subscribe', { user_name: '田中太郎', tier: '1000' })).toEqual({
      event: 'channel.subscribe',
      userName: '田中太郎',
      tier: '1000',
    })
  })

  it('継続サブスクのメッセージから、継続月数も取り出す', () => {
    const event = { user_name: '田中太郎', tier: '2000', cumulative_months: 12 }

    expect(extract('channel.subscription.message', event)).toEqual({
      event: 'channel.subscription.message',
      userName: '田中太郎',
      tier: '2000',
      cumulativeMonths: 12,
    })
  })

  it('レイドから、レイドしてきた配信者と人数を取り出す（受け取る側は to_broadcaster なので from_broadcaster を読む）', () => {
    const event = { from_broadcaster_user_name: '山田花子', to_broadcaster_user_name: '配信者本人', viewers: 42 }

    expect(extract('channel.raid', event)).toEqual({ event: 'channel.raid', userName: '山田花子', viewers: 42 })
  })

  it('対応していないイベントの種類は null を返す（Twitchが種類を増やしてもWorkerを止めない）', () => {
    expect(extract('channel.cheer', { user_name: '田中太郎' })).toBeNull()
  })

  it('通知の中身が想定と違えば、どの項目が足りないかを示してエラーにする', () => {
    expect(() => extract('channel.follow', { user_login: 'tanaka' })).toThrowError(/user_name/)
    expect(() => extract('channel.raid', { from_broadcaster_user_name: '山田花子' })).toThrowError(/viewers/)
    expect(() => extract(REDEMPTION, { user_name: '田中太郎' })).toThrowError(/reward/)
  })
})

describe('matches', () => {
  const 交換のトリガー = (rewardId: string | null): StoredTrigger => ({ event: REDEMPTION, rewardId, actions: [{ type: 'chat', message: '乾杯！' }] })
  const 交換した = { event: REDEMPTION, userName: '田中太郎', rewardId: '報酬ID-乾杯', rewardTitle: '乾杯する' } as const

  it('イベントの種類が違えば当てはまらない', () => {
    const フォローのトリガー: StoredTrigger = { event: 'channel.follow', actions: [{ type: 'chat', message: 'ありがとう' }] }

    expect(matches(フォローのトリガー, 交換した)).toBe(false)
  })

  it('報酬IDが同じチャンネルポイント交換に当てはまる', () => {
    expect(matches(交換のトリガー('報酬ID-乾杯'), 交換した)).toBe(true)
    expect(matches(交換のトリガー('報酬ID-別の報酬'), 交換した)).toBe(false)
  })

  it('報酬IDが null のトリガーは、すべての報酬に当てはまる', () => {
    expect(matches(交換のトリガー(null), 交換した)).toBe(true)
  })
})

describe('fillMessage', () => {
  it('イベントごとの差し込み語を値に置き換える', () => {
    const 継続サブスク = { event: 'channel.subscription.message', userName: '田中太郎', tier: '2000', cumulativeMonths: 12 } as const

    expect(fillMessage('{user} さん、ティア{tier}で{months}か月ありがとう！', 継続サブスク)).toBe('田中太郎 さん、ティア2で12か月ありがとう！')
  })

  it('そのイベントにない差し込み語は残す（入力の誤りに配信者が気付けるようにする）', () => {
    expect(fillMessage('{user} さん、{viewers}人', { event: 'channel.follow', userName: '田中太郎' })).toBe('田中太郎 さん、{viewers}人')
  })

  it('報酬名に $& のような置換の特殊な指定が含まれていても、そのまま差し込む', () => {
    const 交換した = { event: REDEMPTION, userName: '田中太郎', rewardId: '報酬ID', rewardTitle: '$& と $1 の報酬' } as const

    expect(fillMessage('{reward} を交換しました', 交換した)).toBe('$& と $1 の報酬 を交換しました')
  })
})

describe('chatMessageFor', () => {
  const 設定 = (triggers: StoredTrigger[]): AlertConfig => ({ triggers })
  const フォローの通知 = { user_name: '田中太郎' }

  it('当てはまるトリガーのチャットの文言を、差し込み語を置き換えて返す', () => {
    const config = 設定([{ event: 'channel.follow', actions: [{ type: 'chat', message: '{user} さん、フォローありがとうございます！' }] }])

    expect(chatMessageFor(config, 'channel.follow', フォローの通知)).toBe('田中太郎 さん、フォローありがとうございます！')
  })

  it('当てはまるトリガーがなければ null を返す', () => {
    const config = 設定([{ event: 'channel.raid', actions: [{ type: 'chat', message: 'レイドありがとう' }] }])

    expect(chatMessageFor(config, 'channel.follow', フォローの通知)).toBeNull()
  })

  it('チャットに送る動作を持たないトリガー（アラートを出すだけ）には反応しない', () => {
    const アラートだけ: StoredTrigger = {
      event: 'channel.follow',
      actions: [{ type: 'alert', mediaId: '素材ID-拍手の音', mediaKind: 'audio', durationSeconds: 5, volume: 0.5, message: '' }],
    }

    expect(chatMessageFor(設定([アラートだけ]), 'channel.follow', フォローの通知)).toBeNull()
  })

  it('複数のトリガーが当てはまる場合は、先に書かれたものを使う（チャットを連投しない）', () => {
    const config = 設定([
      { event: 'channel.follow', actions: [{ type: 'chat', message: '1つ目の文言' }] },
      { event: 'channel.follow', actions: [{ type: 'chat', message: '2つ目の文言' }] },
    ])

    expect(chatMessageFor(config, 'channel.follow', フォローの通知)).toBe('1つ目の文言')
  })

  it('チャットに送るトリガーがないイベントなら、通知の中身が想定と違ってもエラーにしない（設定していないイベントで止めない）', () => {
    const config = 設定([{ event: 'channel.raid', actions: [{ type: 'chat', message: 'レイドありがとう' }] }])

    expect(chatMessageFor(config, 'channel.follow', { user_login: 'tanaka' })).toBeNull()
  })

  it('対応していないイベントの種類なら null を返す', () => {
    const config = 設定([{ event: 'channel.follow', actions: [{ type: 'chat', message: 'ありがとう' }] }])

    expect(chatMessageFor(config, 'stream.online', { id: '配信ID' })).toBeNull()
  })
})
