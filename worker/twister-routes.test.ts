/**
 * ツイスターの経路（twister-routes.ts）のテスト
 *
 * - 合成ページの接続（GET /api/overlay/twister/socket）は、ツイスターを受け取る接続として配送先へ引き渡す
 * - 管理画面の試し再生（POST /api/admin/twister/demo）は、ログインした配信者にだけ、試しの相手と配信者の対戦を押し出す。
 *   配信者のアイコンは Twitch から引き、引けなければ押し出さずに 502 にする（顔の無い対戦を黙って流さない）
 */
import { describe, expect, it } from 'vitest'
import { parseTwisterCall } from '../src/twister/call'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeBucket } from './fake-bucket'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeStore } from './fake-store'
import { createFakeTabChannel } from './fake-tab-channel'
import { createFakeTokenVault } from './fake-token-vault'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'

const now = Date.parse('2026-10-06T12:00:00Z')
const site = 'https://hdad.example.com'
const overlayKey = 'issued-overlay-key-0123456789abcdefghij'
const BROADCASTER_ID = '12345'
const BROADCASTER_ICON = 'https://static-cdn.jtvnw.net/jtv_user_pictures/tanenobu.png'

const createEnv = (alertChannel = createFakeAlertChannel()) =>
  ({
    STORE: createFakeStore({ 'overlay-key': overlayKey }),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    ASSETS: createFakeAssets(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: BROADCASTER_ID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: alertChannel.namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    TOKENS: createFakeTokenVault().namespace,
    AI: createFakeWorkersAi({ response: '' }),
  }) satisfies Env

const noFetch: typeof fetch = async () => {
  throw new Error('このテストでは外へ通信しません')
}

/** 配信者のアイコンを返す Twitch の代役 */
const twitchReturningBroadcasterIcon: typeof fetch = async (input, init) => {
  const request = new Request(input, init)
  if (request.url === 'https://id.twitch.tv/oauth2/token') return Response.json({ access_token: 'test-app-token' })
  const url = new URL(request.url)
  if (url.origin + url.pathname === 'https://api.twitch.tv/helix/users' && url.searchParams.getAll('id').join() === BROADCASTER_ID) {
    return Response.json({ data: [{ id: BROADCASTER_ID, login: 'tanenobu', profile_image_url: BROADCASTER_ICON }] })
  }
  throw new Error(`テストで想定していない通信です: ${request.url}`)
}

const invoke = (path: string, env: Env, fetchImpl: typeof fetch, init: RequestInit = {}) =>
  handleRequest(new Request(`${site}${path}`, init), env, {
    fetch: fetchImpl,
    now: () => now,
    wait: async () => {},
    waitUntil: () => undefined,
  })

describe('GET /api/overlay/twister/socket', () => {
  it('オーバーレイ用キーが違えば断る', async () => {
    const response = await invoke('/api/overlay/twister/socket?key=wrong-key-0123456789abcdefghijklmn', createEnv(), noFetch, { headers: { Upgrade: 'websocket' } })

    expect(response.status).toBe(401)
  })

  it('WebSocketの接続でなければ400にする', async () => {
    const response = await invoke(`/api/overlay/twister/socket?key=${overlayKey}`, createEnv(), noFetch)

    expect(response.status).toBe(400)
  })

  it('WebSocketの接続なら、ツイスターを受け取る接続として配送先へ引き渡す', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await invoke(`/api/overlay/twister/socket?key=${overlayKey}`, createEnv(alertChannel), noFetch, { headers: { Upgrade: 'websocket' } })

    expect(response.status).toBe(200)
    expect(alertChannel.forwardedConnections.map((request) => new URL(request.url).searchParams.get('topic'))).toEqual(['twister'])
  })
})

describe('POST /api/admin/twister/demo', () => {
  /** 配信者としてログインした状態で呼ぶ。書き換えなので Origin も付ける（ブラウザが付けるのと同じ） */
  const callAsBroadcaster = async (env: Env, fetchImpl: typeof fetch): Promise<Response> => {
    const session = await createSessionToken(env.TWITCH_BROADCASTER_ID, env.SESSION_SECRET, now)
    return invoke('/api/admin/twister/demo', env, fetchImpl, { method: 'POST', headers: { Cookie: `__Host-session=${session}`, Origin: site } })
  }

  it('ログインしていなければ401にし、押し出さない', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await invoke('/api/admin/twister/demo', createEnv(alertChannel), noFetch, { method: 'POST', headers: { Origin: site } })

    expect(response.status).toBe(401)
    expect(alertChannel.pushedTwisters).toEqual([])
  })

  it('試しの相手と、自分のアイコンの配信者の対戦を押し出し、押し出したものを返す', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await callAsBroadcaster(createEnv(alertChannel), twitchReturningBroadcasterIcon)

    expect(response.status).toBe(200)
    expect(alertChannel.pushedTwisters).toHaveLength(1)
    const call = alertChannel.pushedTwisters[0]
    expect(call?.players).toEqual([
      { name: 'レイドした人（試し）', iconUrl: null },
      { name: '配信者', iconUrl: BROADCASTER_ICON },
    ])
    // 合成ページの読み取りがそのまま読める形で押し出す
    expect(parseTwisterCall(JSON.stringify(call))).toEqual(call)
    expect(await response.json()).toEqual(call)
  })

  it('配信者のアイコンを引けなければ、押し出さずに502にする', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await callAsBroadcaster(createEnv(alertChannel), async () => new Response(null, { status: 500 }))

    expect(response.status).toBe(502)
    expect(alertChannel.pushedTwisters).toEqual([])
  })

  it('配送先が失敗したら、黙って成功にせず502にする', async () => {
    const response = await callAsBroadcaster(createEnv(createFakeAlertChannel({ shouldFail: true })), twitchReturningBroadcasterIcon)

    expect(response.status).toBe(502)
  })
})
