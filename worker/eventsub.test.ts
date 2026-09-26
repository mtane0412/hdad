/**
 * 受け取るイベントの一覧とスコープ（eventsub.ts）のテスト
 *
 * ここに並ぶ定義は、Webhook宛ての購読（eventsub-webhook.ts）と配信者・botのログインの両方が使う。
 * 条件（誰のチャンネルか、チャットを誰として読むか）と、そのために要るスコープを確かめる。
 */
import { describe, expect, it } from 'vitest'
import { BOT_SCOPES, EVENT_TYPES, REQUIRED_SCOPES } from './eventsub'

const 条件を作る = (type: string): Record<string, string> | undefined => EVENT_TYPES.find((eventType) => eventType.type === type)?.condition('12345')

describe('EVENT_TYPES', () => {
  it('チャンネルポイント交換・フォロー・サブスク・レイド・チャットの発言・広告の開始を受け取る', () => {
    expect(EVENT_TYPES.map((eventType) => eventType.type)).toEqual([
      'channel.channel_points_custom_reward_redemption.add',
      'channel.follow',
      'channel.subscribe',
      'channel.subscription.message',
      'channel.raid',
      'channel.chat.message',
      'channel.ad_break.begin',
    ])
  })

  it('広告の開始は、配信者のチャンネルを指定する（終了はTwitchから届かないので購読しない）', () => {
    expect(条件を作る('channel.ad_break.begin')).toEqual({ broadcaster_user_id: '12345' })
  })

  it('フォローはバージョン2で、モデレーターとして配信者自身を指定する', () => {
    const follow = EVENT_TYPES.find((eventType) => eventType.type === 'channel.follow')
    expect(follow?.version).toBe('2')
    expect(条件を作る('channel.follow')).toEqual({ broadcaster_user_id: '12345', moderator_user_id: '12345' })
  })

  it('レイドは「自分のチャンネルへ来たレイド」を指定する', () => {
    expect(条件を作る('channel.raid')).toEqual({ to_broadcaster_user_id: '12345' })
  })

  it('チャットの発言は、配信者自身を「チャットを読む人」として指定する（botの接続と関わりなく購読するため）', () => {
    expect(条件を作る('channel.chat.message')).toEqual({ broadcaster_user_id: '12345', user_id: '12345' })
  })
})

describe('REQUIRED_SCOPES / BOT_SCOPES', () => {
  it('配信者には、イベントの購読に要るスコープと channel:bot を要求する', () => {
    // channel:bot は、botのチャットをアプリアクセストークンで購読するために配信者が認可するもの（イベントには紐づかない）
    expect(REQUIRED_SCOPES).toContain('channel:bot')
    expect(REQUIRED_SCOPES).toContain('channel:read:redemptions')
    expect(REQUIRED_SCOPES).toContain('moderator:read:followers')
  })

  it('配信者には user:read:chat と user:bot を要求する（チャットの発言を配信者として読むため）', () => {
    // Webhook宛てのチャットの購読はアプリアクセストークンで作り、「チャットを読む人」に配信者自身を指定する。
    // その場合、読む人（＝配信者）から user:read:chat に加えて user:bot が要る
    expect(REQUIRED_SCOPES).toContain('user:read:chat')
    expect(REQUIRED_SCOPES).toContain('user:bot')
  })

  it('配信者には moderation:read も要求する（botがモデレーターかどうかを確かめるため）', () => {
    expect(REQUIRED_SCOPES).toContain('moderation:read')
  })

  it('配信者には channel:read:ads も要求する（広告の開始を受け取るため）', () => {
    expect(REQUIRED_SCOPES).toContain('channel:read:ads')
  })

  it('配信者に要求するスコープに重複がない', () => {
    expect(REQUIRED_SCOPES).toEqual([...new Set(REQUIRED_SCOPES)])
  })

  it('botには、チャットの読み書きとモデレーション操作に要るスコープを要求する', () => {
    // user:read:chat と user:bot はチャットの受信、user:write:chat は送信、moderator:manage:* は
    // BAN・タイムアウト（banned_users）・発言の削除（chat_messages）・アナウンス（announcements）・
    // シャウトアウト（shoutouts）に要る
    expect(BOT_SCOPES).toEqual([
      'user:bot',
      'user:read:chat',
      'user:write:chat',
      'moderator:manage:banned_users',
      'moderator:manage:chat_messages',
      'moderator:manage:announcements',
      'moderator:manage:shoutouts',
    ])
  })
})
