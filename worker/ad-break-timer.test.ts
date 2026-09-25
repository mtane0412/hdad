/**
 * 広告の終了のタイマー（ad-break-timer.ts）のテスト
 *
 * Twitchには広告の終了に相当する通知がないため、開始の通知に入っている長さ（duration_seconds）から
 * 終わる時刻を出し、Durable Object のアラームでそのときに擬似イベント（channel.ad_break.end）として
 * 同じ照合へ回す。ここでは次の3点を確かめる。
 * - 予約が Durable Object へ渡ること（scheduleAdBreakEnd）
 * - 予約を受けたら、広告が終わる時刻にアラームを仕掛けること
 * - アラームが鳴ったら、広告の終了に当てはまるトリガーの動作（botのチャット）を実行すること
 *
 * アラームは1回しか鳴らないため、予約は storage に1件だけ持ち、鳴ったら消す。
 */
import { describe, expect, it, vi } from 'vitest'
import { AdBreakTimer, scheduleAdBreakEnd, type AdBreakEnd, type AdBreakTimerState } from './ad-break-timer'
import { saveAlertConfig } from './alert-config'
import { listFailures } from './stats-store'
import { createFakeAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeBucket } from './fake-bucket'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'
import type { Env } from './http'
import { saveToken } from './token'

const 現在時刻 = Date.parse('2026-09-25T12:00:00Z')
const 配信者のID = '12345'
const botのID = '67890'

/** Twitchから届く広告の開始の通知の中身。自動で入った3分の広告 */
const 広告の中身 = {
  duration_seconds: 180,
  started_at: '2026-09-25T12:00:00Z',
  is_automatic: true,
  broadcaster_user_id: 配信者のID,
  broadcaster_user_login: 'tanenobu',
  broadcaster_user_name: 'たねのぶ',
  requester_user_id: 配信者のID,
  requester_user_login: 'tanenobu',
  requester_user_name: 'たねのぶ',
}

/** 予約の中身。広告は3分後（現在時刻 + 180秒）に終わる */
const 予約 = (overrides: Partial<AdBreakEnd> = {}): AdBreakEnd => ({
  event: 広告の中身,
  messageId: 'ad-break-message-1',
  endsAt: 現在時刻 + 180 * 1000,
  ...overrides,
})

/** Durable Object の storage の代役。保存した中身と、仕掛けられたアラームの時刻を覚える */
const 保管の代役 = (): { state: AdBreakTimerState; 保管: Map<string, unknown>; 仕掛けたアラーム: number[] } => {
  const 保管 = new Map<string, unknown>()
  const 仕掛けたアラーム: number[] = []
  return {
    保管,
    仕掛けたアラーム,
    state: {
      storage: {
        get: async <T>(key: string): Promise<T | undefined> => 保管.get(key) as T | undefined,
        put: async (key: string, value: unknown): Promise<void> => void 保管.set(key, value),
        delete: async (key: string): Promise<boolean> => 保管.delete(key),
        setAlarm: async (scheduledTime: number): Promise<void> => void 仕掛けたアラーム.push(scheduledTime),
      },
    },
  }
}

/** botを接続済みで、広告の終了のトリガーが1件登録されている環境を作る */
const 環境を作る = async (): Promise<Env> => {
  const env = {
    STORE: createFakeStore({ 'overlay-key': 'issued-overlay-key-0123456789abcdefghij' }),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: 配信者のID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: createFakeAlertChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    AI: createFakeAi(),
  } satisfies Env

  await saveToken(env.STORE, 'bot', {
    accessToken: 'bot-access-token',
    refreshToken: 'bot-refresh-token',
    expiresAt: 現在時刻 + 60 * 60 * 1000,
    scopes: ['user:bot', 'user:read:chat', 'user:write:chat'],
    userId: botのID,
    login: 'haishinsha_bot',
  })
  await saveAlertConfig(env.STORE, {
    triggers: [{ event: 'channel.ad_break.end', conditions: [], actions: [{ type: 'chat', message: '{duration}秒の広告が終わりました。おかえりなさい' }] }],
  })
  return env
}

/** チャット送信に応える Twitch の代役 */
const 送信に応えるTwitch = (): { 送信したチャット: Request[]; fetchImpl: typeof fetch } => {
  const 送信したチャット: Request[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    if (request.url === 'https://api.twitch.tv/helix/chat/messages') {
      送信したチャット.push(request.clone())
      return Response.json({ data: [{ message_id: 'sent', is_sent: true }] })
    }
    throw new Error(`テストで想定していない通信です: ${request.url}`)
  }
  return { 送信したチャット, fetchImpl }
}

/** テストでは実際に待たない */
const 待たない = async (): Promise<void> => {}

describe('scheduleAdBreakEnd', () => {
  it('予約を Durable Object へ渡す', async () => {
    const タイマー = createFakeAdBreakTimer()

    await scheduleAdBreakEnd(タイマー.namespace, 予約())

    expect(タイマー.渡された予約).toEqual([予約()])
  })

  it('Durable Object が失敗を返したら、握りつぶさずに投げる（呼び出し側が失敗として記録する）', async () => {
    const タイマー = createFakeAdBreakTimer({ 失敗する: true })

    await expect(scheduleAdBreakEnd(タイマー.namespace, 予約())).rejects.toThrowError(/予約/)
  })
})

describe('AdBreakTimer', () => {
  it('予約を受け取ったら、広告が終わる時刻にアラームを仕掛ける', async () => {
    const { state, 仕掛けたアラーム } = 保管の代役()
    const env = await 環境を作る()
    const timer = new AdBreakTimer(state, env)

    const response = await timer.fetch(
      new Request('https://ad-break-timer/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(予約()) }),
    )

    expect(response.status).toBe(204)
    // 広告は現在時刻から180秒後に終わる
    expect(仕掛けたアラーム).toEqual([現在時刻 + 180 * 1000])
  })

  it('アラームが鳴ったら、広告の終了として当てはまるトリガーの動作を実行する', async () => {
    const { state, 保管 } = 保管の代役()
    const env = await 環境を作る()
    const twitch = 送信に応えるTwitch()
    const timer = new AdBreakTimer(state, env, { fetch: twitch.fetchImpl, now: () => 現在時刻 + 180 * 1000, wait: 待たない })

    await timer.fetch(
      new Request('https://ad-break-timer/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(予約()) }),
    )
    await timer.alarm()

    // 広告の長さ（{duration}）が差し込まれた文言が、botの名前で送られる
    expect(await twitch.送信したチャット[0]?.json()).toMatchObject({ message: '180秒の広告が終わりました。おかえりなさい', sender_id: botのID })
    // 鳴り終わった予約は残さない（アラームは1回しか鳴らないため）
    expect(保管.size).toBe(0)
  })

  it('予約がないままアラームが鳴っても、何も実行しない', async () => {
    const { state } = 保管の代役()
    const env = await 環境を作る()
    const 通信しない = vi.fn<typeof fetch>(async () => {
      throw new Error('通信してはいけません')
    })
    const timer = new AdBreakTimer(state, env, { fetch: 通信しない, now: () => 現在時刻, wait: 待たない })

    await timer.alarm()

    expect(通信しない).not.toHaveBeenCalled()
  })

  it('動作の実行が失敗しても投げずに、収集の失敗として記録する（予約を消したあとなので、再試行では取り返せない）', async () => {
    const { state } = 保管の代役()
    const env = await 環境を作る()
    // トリガーの設定を読めない状態（保存されている形が古い）にして、照合の手前で失敗させる
    await env.STORE.put('alert-config', JSON.stringify({ triggers: [{ event: 'channel.ad_break.end', rewardId: '報酬ID' }] }))
    const timer = new AdBreakTimer(state, env, { fetch: 送信に応えるTwitch().fetchImpl, now: () => 現在時刻, wait: 待たない })

    await timer.fetch(
      new Request('https://ad-break-timer/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(予約()) }),
    )
    await expect(timer.alarm()).resolves.toBeUndefined()

    expect((await listFailures(env.DB)).map((failure) => failure.code)).toEqual(['ad-break-end-failed'])
  })

  it('知らないパスは404を返す（この Durable Object を呼ぶのは Worker だけ）', async () => {
    const { state } = 保管の代役()
    const env = await 環境を作る()
    const timer = new AdBreakTimer(state, env)

    expect((await timer.fetch(new Request('https://ad-break-timer/unknown'))).status).toBe(404)
  })
})
