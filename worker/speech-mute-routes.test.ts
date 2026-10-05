/**
 * 読み上げのミュートの経路（/api/admin/speech/mute・/api/overlay/speech）のテスト
 *
 * KVと配送先を差し替え、handleRequest を通して確かめる。特に重要なのは次の点である（issue #238）。
 * - 下部バーでミュートを切り替えたら、保存したうえで読み上げのページへ押し出すこと（30秒の読み直しを待たずにすぐ効かせるため）
 * - 読み上げのページが起動のときに、ミュートしているかを設定と一緒に読めること（OBSを読み込み直してもミュートのまま始めるため）
 * - 読み上げのページは、ミュートの知らせを専用の目印の接続で受け取ること
 */
import { describe, expect, it } from 'vitest'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeTokenVault } from './fake-token-vault'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeBucket } from './fake-bucket'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeTabChannel } from './fake-tab-channel'
import { createFakeStore } from './fake-store'
import { loadSpeechMuted } from './speech-config'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'

const NOW = Date.parse('2026-09-29T12:00:00Z')
const BROADCASTER_ID = '12345'
const SITE = 'https://hdad.example.com'
const ISSUED_KEY = 'issued-overlay-key-0123456789abcdefghij'

const setupEnv = () => {
  const alertChannel = createFakeAlertChannel()
  const env = {
    STORE: createFakeStore({ 'overlay-key': ISSUED_KEY }),
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
    AI: createFakeWorkersAi(),
  } satisfies Env
  return { env, alertChannel }
}

const noTwitchFetch = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

const noWait = async (): Promise<void> => {}

/** これらの経路は応答のあとに続く処理（waitUntil）を使わない */
const noWaitUntil = (): void => {
  throw new Error('このテストでは、応答のあとに続く処理を使いません')
}

const callHandler = (request: Request, env: Env) =>
  handleRequest(request, env, { fetch: noTwitchFetch, now: () => NOW, wait: noWait, waitUntil: noWaitUntil })

/** 配信者としてログインした状態で呼ぶ。書き換えのときは Origin も付ける（ブラウザが付けるのと同じ） */
const callAsBroadcaster = async (env: Env, path: string, init: RequestInit = {}): Promise<Response> => {
  const session = await createSessionToken(BROADCASTER_ID, env.SESSION_SECRET, NOW)
  const headers: Record<string, string> = { Cookie: `__Host-session=${session}`, 'Content-Type': 'application/json' }
  if (init.method !== undefined && init.method !== 'GET') headers.Origin = SITE
  return callHandler(new Request(`${SITE}${path}`, { ...init, headers }), env)
}


describe('GET /api/admin/speech/mute', () => {
  it('一度も切り替えていなければ、ミュートしていない', async () => {
    const { env } = setupEnv()

    const response = await callAsBroadcaster(env, '/api/admin/speech/mute')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ muted: false })
  })

  it('ログインしていなければ401にする', async () => {
    const { env } = setupEnv()

    const response = await callHandler(new Request(`${SITE}/api/admin/speech/mute`), env)

    expect(response.status).toBe(401)
  })
})

describe('PUT /api/admin/speech/mute', () => {
  const setMute = (env: Env, body: unknown) => callAsBroadcaster(env, '/api/admin/speech/mute', { method: 'PUT', body: JSON.stringify(body) })

  it('ミュートを保存し、読み上げのページへ押し出す', async () => {
    const { env, alertChannel } = setupEnv()

    const response = await setMute(env, { muted: true })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ muted: true })
    expect(await loadSpeechMuted(env.STORE)).toBe(true)
    expect(alertChannel.pushedSpeechMutes).toEqual([{ muted: true }])
  })

  it('ミュートを解除したことも押し出す', async () => {
    const { env, alertChannel } = setupEnv()
    await setMute(env, { muted: true })

    await setMute(env, { muted: false })

    expect(await loadSpeechMuted(env.STORE)).toBe(false)
    expect(alertChannel.pushedSpeechMutes).toEqual([{ muted: true }, { muted: false }])
  })

  it('真偽値でなければ400にして、保存も押し出しもしない', async () => {
    const { env, alertChannel } = setupEnv()

    const response = await setMute(env, { muted: 'はい' })

    expect(response.status).toBe(400)
    expect(await loadSpeechMuted(env.STORE)).toBe(false)
    expect(alertChannel.pushedSpeechMutes).toEqual([])
  })
})

describe('GET /api/overlay/speech', () => {
  it('読み上げのページへ、設定と一緒にミュートしているかを返す', async () => {
    const { env } = setupEnv()
    await callAsBroadcaster(env, '/api/admin/speech/mute', { method: 'PUT', body: JSON.stringify({ muted: true }) })

    const response = await callHandler(new Request(`${SITE}/api/overlay/speech?key=${ISSUED_KEY}`), env)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ engine: 'local', speaker: 3, muted: true })
  })
})

describe('GET /api/overlay/speech/mute/socket', () => {
  it('読み上げのミュートを受け取る接続として配送先へ引き渡す', async () => {
    const { env, alertChannel } = setupEnv()

    await callHandler(new Request(`${SITE}/api/overlay/speech/mute/socket?key=${ISSUED_KEY}`, { headers: { Upgrade: 'websocket' } }), env)

    expect(alertChannel.forwardedConnections.map((request) => new URL(request.url).searchParams.get('topic'))).toEqual(['speechMute'])
  })

  it('キーが違えば401にする', async () => {
    const { env } = setupEnv()

    const response = await callHandler(new Request(`${SITE}/api/overlay/speech/mute/socket?key=chigau-key`, { headers: { Upgrade: 'websocket' } }), env)

    expect(response.status).toBe(401)
  })

  it('WebSocketでなければ400にする', async () => {
    const { env } = setupEnv()

    const response = await callHandler(new Request(`${SITE}/api/overlay/speech/mute/socket?key=${ISSUED_KEY}`), env)

    expect(response.status).toBe(400)
  })
})
