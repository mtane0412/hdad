/**
 * ポモドーロの経路（/api/admin/pomodoro・/api/overlay/pomodoro）のテスト
 *
 * handleRequest を通して、次の点を確かめる。
 * - 管理画面（ログイン）から、タイマーと休憩の曲の設定を読み、休憩の曲を保存し、タイマーを操作できること
 * - 今の状態でできない操作は409で、知らない操作は400で返ること
 * - 合成ページ（オーバーレイ用キー）から、いまのタイマーを読めること
 *
 * タイマーの中身（区切り・トリガー・BGM）は worker/pomodoro-timer.test.ts が確かめるので、ここでは経路の受け渡しだけを見る。
 */
import { describe, expect, it } from 'vitest'
import type { AdBreakTimerNamespace } from './ad-break-timer'
import { saveBgmTracks, type BgmTrack } from './bgm-config'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeBucket } from './fake-bucket'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeStore } from './fake-store'
import { createFakeTokenVault } from './fake-token-vault'
import { createFakeTabChannel } from './fake-tab-channel'
import { createTimerInstances } from './fake-timer-instances'
import { handleRequest, type Env } from './index'
import { loadPomodoroSettings } from './pomodoro-config'
import { createSessionToken } from './session'

const NOW = Date.parse('2026-10-03T12:00:00Z')
const BROADCASTER_ID = '12345'
const SITE = 'https://hdad.example.com'
const ISSUED_KEY = 'issued-overlay-key-0123456789abcdefghij'

const breakTrack: BgmTrack = { mediaId: 'media-休憩のカフェ', title: '休憩のカフェ', credit: 'フリーBGM配布所', creditUrl: '', mood: '', scene: '' }

const noTwitchFetch = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

/** 配信していない（トリガーは動かない）環境。BGMの一覧には休憩の曲が1つある */
const setupEnv = async () => {
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
    ALERTS: createFakeAlertChannel().namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: undefined as unknown as AdBreakTimerNamespace,
    TOKENS: createFakeTokenVault().namespace,
    AI: createFakeWorkersAi(),
  } satisfies Env
  env.AD_BREAKS = createTimerInstances(() => env, { fetch: noTwitchFetch, now: () => NOW, wait: async () => {} }, () => {}).namespace
  await saveBgmTracks(env.STORE, [breakTrack])
  return env
}

const callHandler = (request: Request, env: Env) =>
  handleRequest(request, env, {
    fetch: noTwitchFetch,
    now: () => NOW,
    wait: async () => {},
    waitUntil: () => {
      throw new Error('このテストでは、応答のあとに続く処理を使いません')
    },
  })

/** 配信者としてログインした状態で呼ぶ。書き換えのときは Origin も付ける（ブラウザが付けるのと同じ） */
const callAsBroadcaster = async (env: Env, path: string, init: RequestInit = {}): Promise<Response> => {
  const session = await createSessionToken(BROADCASTER_ID, env.SESSION_SECRET, NOW)
  const headers: Record<string, string> = { Cookie: `__Host-session=${session}`, 'Content-Type': 'application/json' }
  if (init.method !== undefined && init.method !== 'GET') headers.Origin = SITE
  return callHandler(new Request(`${SITE}${path}`, { ...init, headers }), env)
}

const control = (env: Env, command: unknown) => callAsBroadcaster(env, '/api/admin/pomodoro/control', { method: 'POST', body: JSON.stringify({ command }) })

describe('GET /api/admin/pomodoro', () => {
  it('始めていなければ、タイマーは null で、休憩の曲は選んでいない', async () => {
    const env = await setupEnv()

    const response = await callAsBroadcaster(env, '/api/admin/pomodoro')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ timer: null, settings: { breakMediaId: null } })
  })

  it('ログインしていなければ401にする', async () => {
    const env = await setupEnv()

    expect((await callHandler(new Request(`${SITE}/api/admin/pomodoro`), env)).status).toBe(401)
  })
})

describe('PUT /api/admin/pomodoro/settings', () => {
  it('BGMの一覧にある曲を、休憩の曲として保存する', async () => {
    const env = await setupEnv()

    const response = await callAsBroadcaster(env, '/api/admin/pomodoro/settings', { method: 'PUT', body: JSON.stringify({ breakMediaId: breakTrack.mediaId }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ settings: { breakMediaId: breakTrack.mediaId } })
    expect(await loadPomodoroSettings(env.STORE)).toEqual({ breakMediaId: breakTrack.mediaId })
  })

  it('BGMの一覧に無い曲は、問題点を添えて400にする', async () => {
    const env = await setupEnv()

    const response = await callAsBroadcaster(env, '/api/admin/pomodoro/settings', { method: 'PUT', body: JSON.stringify({ breakMediaId: 'media-消した曲' }) })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { problems: [expect.stringContaining('media-消した曲')] } })
  })
})

describe('POST /api/admin/pomodoro/control', () => {
  it('始めると、始めたタイマーを返す', async () => {
    const env = await setupEnv()

    const response = await control(env, 'start')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ timer: { startedAt: NOW, anchorAt: NOW, pausedAt: null } })
  })

  it('動いているのに始めようとしたら409にする', async () => {
    const env = await setupEnv()
    await control(env, 'start')

    const response = await control(env, 'start')

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'pomodoro-running' } })
  })

  it('知らない操作は400にする', async () => {
    const env = await setupEnv()

    const response = await control(env, 'rewind')

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid-command' } })
  })
})

describe('GET /api/overlay/pomodoro', () => {
  it('オーバーレイ用キーで、いまのタイマーを読める', async () => {
    const env = await setupEnv()
    await control(env, 'start')

    const response = await callHandler(new Request(`${SITE}/api/overlay/pomodoro?key=${ISSUED_KEY}`), env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ timer: { startedAt: NOW, anchorAt: NOW, pausedAt: null } })
  })

  it('キーが違えば受け付けない', async () => {
    const env = await setupEnv()

    const response = await callHandler(new Request(`${SITE}/api/overlay/pomodoro?key=wrong-key`), env)

    expect(response.status).toBe(401)
  })
})

describe('GET /api/overlay/pomodoro/socket', () => {
  it('WebSocketの接続でなければ400にする', async () => {
    const env = await setupEnv()

    const response = await callHandler(new Request(`${SITE}/api/overlay/pomodoro/socket?key=${ISSUED_KEY}`), env)

    expect(response.status).toBe(400)
  })
})
