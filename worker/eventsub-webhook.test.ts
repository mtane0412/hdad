/**
 * Webhook宛てのEventSub（eventsub-webhook.ts）のテスト
 *
 * 通知の署名の検証と、Webhook宛ての購読を揃える処理を確かめる。Twitchへの通信は差し替える。
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ensureWebhookSubscriptions, verifyWebhookSignature, webhookEventTypes } from './eventsub-webhook'
import { TwitchApiError, type EventSubSubscription, type RegisteredSubscription } from './twitch'

const SECRET = 'テスト用のWebhookシークレット'
const CALLBACK_URL = 'https://hdad.example.com/api/eventsub/webhook'

describe('verifyWebhookSignature', () => {
  const notification = { messageId: 'メッセージ1', timestamp: '2026-09-21T12:00:00.123456789Z', body: '{"event":{}}' }
  const validSignature = `sha256=${createHmac('sha256', SECRET).update(notification.messageId + notification.timestamp + notification.body).digest('hex')}`

  it('メッセージID・タイムスタンプ・本文をつなげたHMAC-SHA256と一致すれば通す', async () => {
    expect(await verifyWebhookSignature({ ...notification, signature: validSignature, secret: SECRET })).toBe(true)
  })

  it('本文が書き換えられていたら通さない', async () => {
    expect(await verifyWebhookSignature({ ...notification, body: '{"event":{"偽物":true}}', signature: validSignature, secret: SECRET })).toBe(false)
  })

  it('別のシークレットで作った署名は通さない', async () => {
    expect(await verifyWebhookSignature({ ...notification, signature: validSignature, secret: '別のシークレット' })).toBe(false)
  })
})

describe('ensureWebhookSubscriptions', () => {
  const createFakeTwitch = (registered: RegisteredSubscription[]) => ({
    getAppAccessToken: vi.fn(async () => 'test-app-token'),
    listSubscriptions: vi.fn(async () => registered),
    deleteSubscription: vi.fn(async () => undefined),
    createSubscription: vi.fn<(accessToken: string, subscription: EventSubSubscription) => Promise<void>>(async () => undefined),
  })

  const ensure = (twitch: ReturnType<typeof createFakeTwitch>) =>
    ensureWebhookSubscriptions({ twitch, broadcasterId: '12345', callbackUrl: CALLBACK_URL, secret: SECRET })

  it('何も登録されていなければ、サブスク・ポイント交換・フォロー・レイド・チャット（発言・お知らせ・削除・消去）・広告の開始・配信の開始と終了を、アプリアクセストークンでWebhook宛てに登録する', async () => {
    const twitch = createFakeTwitch([])
    const created = await ensure(twitch)

    expect(created).toEqual([
      'channel.channel_points_custom_reward_redemption.add',
      'channel.follow',
      'channel.subscribe',
      'channel.subscription.message',
      'channel.raid',
      'channel.chat.message',
      'channel.chat.notification',
      'channel.chat.message_delete',
      'channel.chat.clear_user_messages',
      'channel.chat.clear',
      'channel.ad_break.begin',
      'stream.online',
      'stream.offline',
    ])
    expect(created).toEqual(webhookEventTypes())
    for (const [accessToken, subscription] of twitch.createSubscription.mock.calls) {
      expect(accessToken).toBe('test-app-token')
      expect(subscription.transport).toEqual({ method: 'webhook', callback: CALLBACK_URL, secret: SECRET })
    }
    const raid = twitch.createSubscription.mock.calls.find(([, subscription]) => subscription.type === 'channel.raid')?.[1]
    expect(raid?.condition).toEqual({ to_broadcaster_user_id: '12345' })
    // フォローは件数を数えないが、アラートのトリガー（チャットへのお礼）のために購読する。条件には自分自身をモデレーターとして渡す
    const follow = twitch.createSubscription.mock.calls.find(([, subscription]) => subscription.type === 'channel.follow')?.[1]
    expect(follow?.condition).toEqual({ broadcaster_user_id: '12345', moderator_user_id: '12345' })
  })

  it('有効な購読と確認待ちの購読は、登録し直さない', async () => {
    const twitch = createFakeTwitch([
      { id: '購読1', status: 'enabled', type: 'stream.online', version: '1', condition: { broadcaster_user_id: '12345' }, callback: CALLBACK_URL },
      { id: '購読2', status: 'webhook_callback_verification_pending', type: 'stream.offline', version: '1', condition: { broadcaster_user_id: '12345' }, callback: CALLBACK_URL },
    ])
    const created = await ensure(twitch)

    expect(created).not.toContain('stream.online')
    expect(created).not.toContain('stream.offline')
    expect(created).toHaveLength(11)
    expect(twitch.deleteSubscription).not.toHaveBeenCalled()
  })

  it('失効した購読は、消してから登録し直す', async () => {
    const twitch = createFakeTwitch([{ id: '購読1', status: 'authorization_revoked', type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: '12345' }, callback: CALLBACK_URL }])
    const created = await ensure(twitch)

    expect(twitch.deleteSubscription).toHaveBeenCalledWith('test-app-token', '購読1')
    expect(created).toContain('channel.raid')
  })

  it('種類が同じでも、条件（配信者）やバージョンが違う購読は使わない。消してから正しい内容で登録する', async () => {
    const twitch = createFakeTwitch([
      { id: '購読1', status: 'enabled', type: 'stream.online', version: '1', condition: { broadcaster_user_id: '99999' }, callback: CALLBACK_URL },
    ])
    const created = await ensure(twitch)

    expect(twitch.deleteSubscription).toHaveBeenCalledWith('test-app-token', '購読1')
    expect(created).toContain('stream.online')
  })

  it('別のコールバック宛ての購読（別の環境のもの）には触れず、数にも入れない', async () => {
    const twitch = createFakeTwitch([
      { id: '購読1', status: 'notification_failures_exceeded', type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: '12345' }, callback: 'https://other.example.com/api/eventsub/webhook' },
      { id: '購読2', status: 'enabled', type: 'stream.online', version: '1', condition: { broadcaster_user_id: '12345' }, callback: 'https://other.example.com/api/eventsub/webhook' },
    ])
    const created = await ensure(twitch)

    expect(twitch.deleteSubscription).not.toHaveBeenCalled()
    expect(created).toHaveLength(13)
  })

  it('Twitchが購読を拒否したら、どのイベントかを示すエラーになる', async () => {
    const twitch = createFakeTwitch([])
    twitch.createSubscription.mockRejectedValueOnce(new TwitchApiError(403, 'subscription missing proper authorization'))

    await expect(ensure(twitch)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('channel.channel_points_custom_reward_redemption.add'),
    })
  })
})

describe('ensureWebhookSubscriptions（チャットの購読）', () => {
  const createFakeTwitch = (registered: RegisteredSubscription[]) => ({
    getAppAccessToken: vi.fn(async () => 'test-app-token'),
    listSubscriptions: vi.fn(async () => registered),
    deleteSubscription: vi.fn(async () => undefined),
    createSubscription: vi.fn<(accessToken: string, subscription: EventSubSubscription) => Promise<void>>(async () => undefined),
  })

  const ensure = (twitch: ReturnType<typeof createFakeTwitch>) =>
    ensureWebhookSubscriptions({ twitch, broadcasterId: '12345', callbackUrl: CALLBACK_URL, secret: SECRET })

  /** 「チャットを読む人」に指定したユーザーIDで登録済みの、チャットの購読 */
  const chatSubscription = (readerUserId: string): RegisteredSubscription => ({
    id: '購読チャット',
    status: 'enabled',
    type: 'channel.chat.message',
    version: '1',
    condition: { broadcaster_user_id: '12345', user_id: readerUserId },
    callback: CALLBACK_URL,
  })

  it('「チャットを読む人」には配信者自身を指定して購読する', async () => {
    const twitch = createFakeTwitch([])

    const created = await ensure(twitch)

    expect(created).toContain('channel.chat.message')
    const chat = twitch.createSubscription.mock.calls.find(([, subscription]) => subscription.type === 'channel.chat.message')?.[1]
    expect(chat).toMatchObject({ version: '1', condition: { broadcaster_user_id: '12345', user_id: '12345' } })
  })

  it('botを接続していなくてもチャットを購読する（購読はbotと無関係になったため）', async () => {
    const twitch = createFakeTwitch([])

    expect(await ensure(twitch)).toContain('channel.chat.message')
  })

  it('「チャットを読む人」がbotになっている古い購読は、消して配信者で登録し直す', async () => {
    const twitch = createFakeTwitch([chatSubscription('67890')])

    const created = await ensure(twitch)

    expect(twitch.deleteSubscription).toHaveBeenCalledWith('test-app-token', '購読チャット')
    expect(created).toContain('channel.chat.message')
    const chat = twitch.createSubscription.mock.calls.find(([, subscription]) => subscription.type === 'channel.chat.message')?.[1]
    expect(chat?.condition).toEqual({ broadcaster_user_id: '12345', user_id: '12345' })
  })

  it('同じ内容で揃え直しても、チャットの購読は登録し直さない', async () => {
    const twitch = createFakeTwitch([chatSubscription('12345')])

    const created = await ensure(twitch)

    expect(twitch.deleteSubscription).not.toHaveBeenCalled()
    expect(created).not.toContain('channel.chat.message')
  })
})
