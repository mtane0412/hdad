/**
 * EventSub購読の代行（eventsub.ts）のテスト
 *
 * オーバーレイが開いたWebSocketのセッションIDに対して、Workerが保管しているトークンで購読を登録する。
 * スコープ不足やTwitch側の拒否は、一部だけ登録して黙って進まずエラーにする。
 */
import { describe, expect, it, vi } from 'vitest'
import { buildSubscriptions, REQUIRED_SCOPES, subscribeAll } from './eventsub'
import { createFakeStore } from './fake-store'
import { saveToken, type StoredToken } from './token'
import { TwitchApiError, type EventSubSubscription } from './twitch'

const 現在時刻 = Date.UTC(2026, 8, 21, 12, 0, 0)

const 保存済みトークン = (scopes: readonly string[]): StoredToken => ({
  accessToken: '保存済みのアクセストークン',
  refreshToken: '保存済みのリフレッシュトークン',
  expiresAt: 現在時刻 + 60 * 60 * 1000,
  scopes: [...scopes],
  userId: '12345',
  login: 'haishinsha',
})

describe('buildSubscriptions', () => {
  it('チャンネルポイント交換・フォロー・サブスク・レイドの購読を、WebSocketのセッション宛てに組み立てる', () => {
    const subscriptions = buildSubscriptions('12345', 'セッションID')

    expect(subscriptions.map((subscription) => subscription.type)).toEqual([
      'channel.channel_points_custom_reward_redemption.add',
      'channel.follow',
      'channel.subscribe',
      'channel.subscription.message',
      'channel.raid',
    ])
    for (const subscription of subscriptions) {
      expect(subscription.transport).toEqual({ method: 'websocket', session_id: 'セッションID' })
    }
  })

  it('フォローはバージョン2で、モデレーターとして配信者自身を指定する', () => {
    const follow = buildSubscriptions('12345', 'セッションID').find((subscription) => subscription.type === 'channel.follow')
    expect(follow).toMatchObject({ version: '2', condition: { broadcaster_user_id: '12345', moderator_user_id: '12345' } })
  })

  it('レイドは「自分のチャンネルへ来たレイド」を指定する', () => {
    const raid = buildSubscriptions('12345', 'セッションID').find((subscription) => subscription.type === 'channel.raid')
    expect(raid?.condition).toEqual({ to_broadcaster_user_id: '12345' })
  })
})

describe('subscribeAll', () => {
  const 更新できるTwitch = (createSubscription: (accessToken: string, subscription: EventSubSubscription) => Promise<void>) => ({
    refresh: vi.fn(async () => ({ accessToken: '新しいアクセストークン', refreshToken: '新しいリフレッシュトークン', expiresIn: 14400 })),
    createSubscription: vi.fn(createSubscription),
  })

  it('すべての購読を登録し、登録したイベントの種類を返す', async () => {
    const store = createFakeStore()
    await saveToken(store, 保存済みトークン(REQUIRED_SCOPES))
    const twitch = 更新できるTwitch(async () => {})

    const types = await subscribeAll({ store, twitch, broadcasterId: '12345', sessionId: 'セッションID', now: 現在時刻 })

    expect(types).toHaveLength(5)
    expect(twitch.createSubscription).toHaveBeenCalledTimes(5)
    expect(twitch.createSubscription).toHaveBeenCalledWith('保存済みのアクセストークン', expect.objectContaining({ type: 'channel.raid' }))
  })

  it('保存済みトークンのスコープが足りなければ、Twitchへ送る前に不足分を示すエラーになる', async () => {
    const store = createFakeStore()
    await saveToken(store, 保存済みトークン(['channel:read:redemptions']))
    const twitch = 更新できるTwitch(async () => {})

    await expect(
      subscribeAll({ store, twitch, broadcasterId: '12345', sessionId: 'セッションID', now: 現在時刻 }),
    ).rejects.toMatchObject({ name: 'AuthError', code: 'missing-scope', message: expect.stringContaining('moderator:read:followers') })
    expect(twitch.createSubscription).not.toHaveBeenCalled()
  })

  it('Twitchに401（トークン無効）を返されたら、トークンを取り直して同じ購読をやり直す', async () => {
    const store = createFakeStore()
    await saveToken(store, 保存済みトークン(REQUIRED_SCOPES))
    const twitch = 更新できるTwitch(async (accessToken) => {
      if (accessToken === '保存済みのアクセストークン') throw new TwitchApiError(401, 'Invalid OAuth token')
    })

    const types = await subscribeAll({ store, twitch, broadcasterId: '12345', sessionId: 'セッションID', now: 現在時刻 })

    expect(types).toHaveLength(5)
    expect(twitch.refresh).toHaveBeenCalledTimes(1)
    // 1件目が401で失敗 → 取り直して1件目をやり直すので、合計6回
    expect(twitch.createSubscription).toHaveBeenCalledTimes(6)
  })

  it('取り直したトークンでも401なら、やり直しを繰り返さずエラーにする', async () => {
    const store = createFakeStore()
    await saveToken(store, 保存済みトークン(REQUIRED_SCOPES))
    const twitch = 更新できるTwitch(async () => {
      throw new TwitchApiError(401, 'Invalid OAuth token')
    })

    await expect(
      subscribeAll({ store, twitch, broadcasterId: '12345', sessionId: 'セッションID', now: 現在時刻 }),
    ).rejects.toMatchObject({ name: 'TwitchApiError', status: 401 })
    expect(twitch.refresh).toHaveBeenCalledTimes(1)
  })

  it('Twitchに拒否された購読があれば、どのイベントで失敗したかを含むエラーにする', async () => {
    const store = createFakeStore()
    await saveToken(store, 保存済みトークン(REQUIRED_SCOPES))
    const twitch = 更新できるTwitch(async (_accessToken, subscription) => {
      if (subscription.type === 'channel.follow') throw new TwitchApiError(403, 'subscription missing proper authorization')
    })

    await expect(
      subscribeAll({ store, twitch, broadcasterId: '12345', sessionId: 'セッションID', now: 現在時刻 }),
    ).rejects.toMatchObject({ status: 403, message: expect.stringContaining('channel.follow') })
  })
})
