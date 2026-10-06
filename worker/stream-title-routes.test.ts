/**
 * 配信タイトルの候補づくりの設定の経路（/api/admin/stream-title/settings）のテスト
 *
 * KV・D1を差し替え、handleRequest を通して、設定の読み出しと保存・検証の失敗・ログインの要求を確かめる。
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
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'
import { loadStreamTitleSettings } from './stream-title-config'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const BROADCASTER_ID = '12345'
const SITE = 'https://hdad.example.com'

const setupEnv = () => {
  const env = {
    STORE: createFakeStore(),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    ASSETS: createFakeAssets(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: BROADCASTER_ID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: createFakeAlertChannel().namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    TOKENS: createFakeTokenVault().namespace,
    AI: createFakeWorkersAi(),
  } satisfies Env
  return env
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

describe('GET /api/admin/stream-title/settings', () => {
  it('一度も保存していなければ、候補を作らない設定を返す', async () => {
    const env = setupEnv()

    const response = await callAsBroadcaster(env, '/api/admin/stream-title/settings')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ settings: { enabled: false } })
  })

  it('ログインしていなければ401にする', async () => {
    const env = setupEnv()

    const response = await callHandler(new Request(`${SITE}/api/admin/stream-title/settings`), env)

    expect(response.status).toBe(401)
  })
})

describe('PUT /api/admin/stream-title/settings', () => {
  it('候補を作るかを保存して返す', async () => {
    const env = setupEnv()

    const response = await callAsBroadcaster(env, '/api/admin/stream-title/settings', { method: 'PUT', body: JSON.stringify({ enabled: true }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ settings: { enabled: true } })
    expect(await loadStreamTitleSettings(env.STORE)).toEqual({ enabled: true })
  })

  it('問題があれば400にして、保存しない', async () => {
    const env = setupEnv()

    const response = await callAsBroadcaster(env, '/api/admin/stream-title/settings', { method: 'PUT', body: JSON.stringify({ enabled: 'はい' }) })

    expect(response.status).toBe(400)
    expect(await loadStreamTitleSettings(env.STORE)).toEqual({ enabled: false })
  })

  it('ログインしていなければ401にする', async () => {
    const env = setupEnv()

    const response = await callHandler(new Request(`${SITE}/api/admin/stream-title/settings`, { method: 'PUT', body: '{}' }), env)

    expect(response.status).toBe(401)
  })
})
