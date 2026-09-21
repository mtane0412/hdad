/**
 * EventSub WebSocketのメッセージの解釈（eventsub.ts）のテスト
 *
 * Twitchから届くJSONを、接続の管理（welcome・keepalive・reconnect）と通知（notification）に分けて取り出せることを確認する。
 * 形の崩れたメッセージを黙って無視せずエラーにすることも重要（気付かないままアラートが出なくなるのを避ける）。
 */
import { describe, expect, it } from 'vitest'
import { createSeenIds, parseEventSubMessage } from './eventsub'

const メッセージ = (messageType: string, payload: unknown, extraMetadata: Record<string, string> = {}): string =>
  JSON.stringify({
    metadata: { message_id: 'メッセージID-1', message_type: messageType, message_timestamp: '2026-09-21T12:00:00Z', ...extraMetadata },
    payload,
  })

describe('parseEventSubMessage', () => {
  it('session_welcome から、購読に使うセッションIDとキープアライブの間隔を取り出す', () => {
    const text = メッセージ('session_welcome', {
      session: { id: 'セッションID', status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null },
    })
    expect(parseEventSubMessage(text)).toEqual({ type: 'welcome', sessionId: 'セッションID', keepaliveTimeoutSeconds: 10 })
  })

  it('session_keepalive は、接続が生きていることだけを知らせる', () => {
    expect(parseEventSubMessage(メッセージ('session_keepalive', {}))).toEqual({ type: 'keepalive' })
  })

  it('notification から、メッセージID・イベントの種類・イベントの中身を取り出す', () => {
    const text = メッセージ(
      'notification',
      {
        subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
        event: { user_name: 'たねのぶ', reward: { id: '報酬ID', title: '水を飲む' } },
      },
      { subscription_type: 'channel.channel_points_custom_reward_redemption.add' },
    )
    expect(parseEventSubMessage(text)).toEqual({
      type: 'notification',
      id: 'メッセージID-1',
      subscriptionType: 'channel.channel_points_custom_reward_redemption.add',
      event: { user_name: 'たねのぶ', reward: { id: '報酬ID', title: '水を飲む' } },
    })
  })

  it('session_reconnect から、つなぎ直し先のURLを取り出す', () => {
    const text = メッセージ('session_reconnect', {
      session: { id: 'セッションID', status: 'reconnecting', reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?challenge=abc' },
    })
    expect(parseEventSubMessage(text)).toEqual({ type: 'reconnect', url: 'wss://eventsub.wss.twitch.tv/ws?challenge=abc' })
  })

  it('revocation から、取り消された購読の種類と理由を取り出す', () => {
    const text = メッセージ('revocation', {
      subscription: { type: 'channel.follow', status: 'authorization_revoked' },
    })
    expect(parseEventSubMessage(text)).toEqual({ type: 'revocation', subscriptionType: 'channel.follow', status: 'authorization_revoked' })
  })

  it('知らない種類のメッセージはエラーにする', () => {
    expect(() => parseEventSubMessage(メッセージ('session_unknown', {}))).toThrow('session_unknown')
  })

  it('必要な項目が欠けたメッセージはエラーにする', () => {
    expect(() => parseEventSubMessage(メッセージ('session_welcome', { session: {} }))).toThrow('session_welcome')
    expect(() => parseEventSubMessage('JSONではない文字列')).toThrow()
  })
})

describe('createSeenIds', () => {
  it('初めてのIDは false、2回目以降は true を返す（Twitchは同じ通知を再送することがある）', () => {
    const seen = createSeenIds(10)
    expect(seen('メッセージID-1')).toBe(false)
    expect(seen('メッセージID-1')).toBe(true)
    expect(seen('メッセージID-2')).toBe(false)
  })

  it('覚えておく件数の上限を超えたら、古いIDから忘れる', () => {
    const seen = createSeenIds(2)
    seen('メッセージID-1')
    seen('メッセージID-2')
    seen('メッセージID-3')
    expect(seen('メッセージID-3')).toBe(true)
    expect(seen('メッセージID-1')).toBe(false)
  })
})
