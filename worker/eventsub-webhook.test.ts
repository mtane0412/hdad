/**
 * Webhook宛てのEventSub（eventsub-webhook.ts）のテスト
 *
 * 通知の署名の検証と、Webhook宛ての購読を揃える処理を確かめる。Twitchへの通信は差し替える。
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ensureWebhookSubscriptions, verifyWebhookSignature, webhookEventTypes } from './eventsub-webhook'
import { TwitchApiError, type EventSubSubscription, type RegisteredSubscription } from './twitch'

const シークレット = 'テスト用のWebhookシークレット'
const コールバック = 'https://hdad.example.com/api/eventsub/webhook'

describe('verifyWebhookSignature', () => {
  const 通知 = { messageId: 'メッセージ1', timestamp: '2026-09-21T12:00:00.123456789Z', body: '{"event":{}}' }
  const 正しい署名 = `sha256=${createHmac('sha256', シークレット).update(通知.messageId + 通知.timestamp + 通知.body).digest('hex')}`

  it('メッセージID・タイムスタンプ・本文をつなげたHMAC-SHA256と一致すれば通す', async () => {
    expect(await verifyWebhookSignature({ ...通知, signature: 正しい署名, secret: シークレット })).toBe(true)
  })

  it('本文が書き換えられていたら通さない', async () => {
    expect(await verifyWebhookSignature({ ...通知, body: '{"event":{"偽物":true}}', signature: 正しい署名, secret: シークレット })).toBe(false)
  })

  it('別のシークレットで作った署名は通さない', async () => {
    expect(await verifyWebhookSignature({ ...通知, signature: 正しい署名, secret: '別のシークレット' })).toBe(false)
  })
})

describe('ensureWebhookSubscriptions', () => {
  const Twitchの代役 = (registered: RegisteredSubscription[]) => ({
    getAppAccessToken: vi.fn(async () => 'test-app-token'),
    listSubscriptions: vi.fn(async () => registered),
    deleteSubscription: vi.fn(async () => undefined),
    createSubscription: vi.fn<(accessToken: string, subscription: EventSubSubscription) => Promise<void>>(async () => undefined),
  })

  const 揃える = (twitch: ReturnType<typeof Twitchの代役>) =>
    ensureWebhookSubscriptions({ twitch, broadcasterId: '12345', callbackUrl: コールバック, secret: シークレット })

  it('何も登録されていなければ、サブスク・ポイント交換・フォロー・レイド・チャット・配信の開始と終了を、アプリアクセストークンでWebhook宛てに登録する', async () => {
    const twitch = Twitchの代役([])
    const created = await 揃える(twitch)

    expect(created).toEqual([
      'channel.channel_points_custom_reward_redemption.add',
      'channel.follow',
      'channel.subscribe',
      'channel.subscription.message',
      'channel.raid',
      'channel.chat.message',
      'stream.online',
      'stream.offline',
    ])
    expect(created).toEqual(webhookEventTypes())
    for (const [accessToken, subscription] of twitch.createSubscription.mock.calls) {
      expect(accessToken).toBe('test-app-token')
      expect(subscription.transport).toEqual({ method: 'webhook', callback: コールバック, secret: シークレット })
    }
    const raid = twitch.createSubscription.mock.calls.find(([, subscription]) => subscription.type === 'channel.raid')?.[1]
    expect(raid?.condition).toEqual({ to_broadcaster_user_id: '12345' })
    // フォローは件数を数えないが、アラートのトリガー（チャットへのお礼）のために購読する。条件には自分自身をモデレーターとして渡す
    const follow = twitch.createSubscription.mock.calls.find(([, subscription]) => subscription.type === 'channel.follow')?.[1]
    expect(follow?.condition).toEqual({ broadcaster_user_id: '12345', moderator_user_id: '12345' })
  })

  it('有効な購読と確認待ちの購読は、登録し直さない', async () => {
    const twitch = Twitchの代役([
      { id: '購読1', status: 'enabled', type: 'stream.online', version: '1', condition: { broadcaster_user_id: '12345' }, callback: コールバック },
      { id: '購読2', status: 'webhook_callback_verification_pending', type: 'stream.offline', version: '1', condition: { broadcaster_user_id: '12345' }, callback: コールバック },
    ])
    const created = await 揃える(twitch)

    expect(created).not.toContain('stream.online')
    expect(created).not.toContain('stream.offline')
    expect(created).toHaveLength(6)
    expect(twitch.deleteSubscription).not.toHaveBeenCalled()
  })

  it('失効した購読は、消してから登録し直す', async () => {
    const twitch = Twitchの代役([{ id: '購読1', status: 'authorization_revoked', type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: '12345' }, callback: コールバック }])
    const created = await 揃える(twitch)

    expect(twitch.deleteSubscription).toHaveBeenCalledWith('test-app-token', '購読1')
    expect(created).toContain('channel.raid')
  })

  it('種類が同じでも、条件（配信者）やバージョンが違う購読は使わない。消してから正しい内容で登録する', async () => {
    const twitch = Twitchの代役([
      { id: '購読1', status: 'enabled', type: 'stream.online', version: '1', condition: { broadcaster_user_id: '99999' }, callback: コールバック },
    ])
    const created = await 揃える(twitch)

    expect(twitch.deleteSubscription).toHaveBeenCalledWith('test-app-token', '購読1')
    expect(created).toContain('stream.online')
  })

  it('別のコールバック宛ての購読（別の環境のもの）には触れず、数にも入れない', async () => {
    const twitch = Twitchの代役([
      { id: '購読1', status: 'notification_failures_exceeded', type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: '12345' }, callback: 'https://other.example.com/api/eventsub/webhook' },
      { id: '購読2', status: 'enabled', type: 'stream.online', version: '1', condition: { broadcaster_user_id: '12345' }, callback: 'https://other.example.com/api/eventsub/webhook' },
    ])
    const created = await 揃える(twitch)

    expect(twitch.deleteSubscription).not.toHaveBeenCalled()
    expect(created).toHaveLength(8)
  })

  it('Twitchが購読を拒否したら、どのイベントかを示すエラーになる', async () => {
    const twitch = Twitchの代役([])
    twitch.createSubscription.mockRejectedValueOnce(new TwitchApiError(403, 'subscription missing proper authorization'))

    await expect(揃える(twitch)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('channel.channel_points_custom_reward_redemption.add'),
    })
  })
})

describe('ensureWebhookSubscriptions（チャットの購読）', () => {
  const Twitchの代役 = (registered: RegisteredSubscription[]) => ({
    getAppAccessToken: vi.fn(async () => 'test-app-token'),
    listSubscriptions: vi.fn(async () => registered),
    deleteSubscription: vi.fn(async () => undefined),
    createSubscription: vi.fn<(accessToken: string, subscription: EventSubSubscription) => Promise<void>>(async () => undefined),
  })

  const 揃える = (twitch: ReturnType<typeof Twitchの代役>) =>
    ensureWebhookSubscriptions({ twitch, broadcasterId: '12345', callbackUrl: コールバック, secret: シークレット })

  /** 「チャットを読む人」に指定したユーザーIDで登録済みの、チャットの購読 */
  const チャットの購読 = (読む人のユーザーId: string): RegisteredSubscription => ({
    id: '購読チャット',
    status: 'enabled',
    type: 'channel.chat.message',
    version: '1',
    condition: { broadcaster_user_id: '12345', user_id: 読む人のユーザーId },
    callback: コールバック,
  })

  it('「チャットを読む人」には配信者自身を指定して購読する', async () => {
    const twitch = Twitchの代役([])

    const created = await 揃える(twitch)

    expect(created).toContain('channel.chat.message')
    const chat = twitch.createSubscription.mock.calls.find(([, subscription]) => subscription.type === 'channel.chat.message')?.[1]
    expect(chat).toMatchObject({ version: '1', condition: { broadcaster_user_id: '12345', user_id: '12345' } })
  })

  it('botを接続していなくてもチャットを購読する（購読はbotと無関係になったため）', async () => {
    const twitch = Twitchの代役([])

    expect(await 揃える(twitch)).toContain('channel.chat.message')
  })

  it('「チャットを読む人」がbotになっている古い購読は、消して配信者で登録し直す', async () => {
    const twitch = Twitchの代役([チャットの購読('67890')])

    const created = await 揃える(twitch)

    expect(twitch.deleteSubscription).toHaveBeenCalledWith('test-app-token', '購読チャット')
    expect(created).toContain('channel.chat.message')
    const chat = twitch.createSubscription.mock.calls.find(([, subscription]) => subscription.type === 'channel.chat.message')?.[1]
    expect(chat?.condition).toEqual({ broadcaster_user_id: '12345', user_id: '12345' })
  })

  it('同じ内容で揃え直しても、チャットの購読は登録し直さない', async () => {
    const twitch = Twitchの代役([チャットの購読('12345')])

    const created = await 揃える(twitch)

    expect(twitch.deleteSubscription).not.toHaveBeenCalled()
    expect(created).not.toContain('channel.chat.message')
  })
})
