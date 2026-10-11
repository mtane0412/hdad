/**
 * ペロペロの経路（lick-routes.ts）のテスト
 *
 * - 合成ページの接続（GET /api/overlay/lick/socket）は、ペロペロを受け取る接続として配送先へ引き渡す
 * - 管理画面の試し再生（POST /api/admin/lick/demo）は、ログインした配信者にだけ、ペロペロを押し出す。
 *   本文で相手のログイン名を渡せば、Twitch で引いたその人の表示名とアイコンを舐める。省けばアイコンの無い試しの相手を舐める。
 *   ログイン名の形でなければ400、Twitch にいなければ404にし、どちらも押し出さない
 * - 試し再生もトリガーと同じ効果音の設定を添えて押し出す。効果音を選んでいるのにオーバーレイ用キーが未発行なら409にして押し出さない
 * - 効果音の設定（GET・PUT /api/admin/lick/sound）は、ログインした配信者にだけ読み書きさせ、音声でない素材を選んだ設定は400で断る
 */
import { describe, expect, it } from 'vitest'
import { parseLickCall } from '../src/lick/call'
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
import { DEFAULT_LICK_SOUND, loadLickSound, saveLickSound } from './lick-sound'

const now = Date.parse('2026-10-11T12:00:00Z')
const site = 'https://hdad.example.com'
const overlayKey = 'issued-overlay-key-0123456789abcdefghij'
const BROADCASTER_ID = '12345'

const createEnv = (alertChannel = createFakeAlertChannel(), store = createFakeStore({ 'overlay-key': overlayKey })) =>
  ({
    STORE: store,
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

const TARGET_LOGIN = 'yamada_hanako'
const TARGET_ICON = 'https://static-cdn.jtvnw.net/jtv_user_pictures/yamada.png'

/** ログイン名 yamada_hanako の人（表示名は山田花子）を返す Twitch の代役。ほかのログイン名はいないことにする */
const twitchKnowingTarget: typeof fetch = async (input, init) => {
  const request = new Request(input, init)
  if (request.url === 'https://id.twitch.tv/oauth2/token') return Response.json({ access_token: 'test-app-token' })
  const url = new URL(request.url)
  if (url.origin + url.pathname === 'https://api.twitch.tv/helix/users' && url.searchParams.has('login')) {
    if (url.searchParams.get('login') !== TARGET_LOGIN) return Response.json({ data: [] })
    return Response.json({ data: [{ id: '1111', login: TARGET_LOGIN, display_name: '山田花子', description: '', profile_image_url: TARGET_ICON }] })
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

describe('GET /api/overlay/lick/socket', () => {
  it('オーバーレイ用キーが違えば断る', async () => {
    const response = await invoke('/api/overlay/lick/socket?key=wrong-key-0123456789abcdefghijklmn', createEnv(), noFetch, { headers: { Upgrade: 'websocket' } })

    expect(response.status).toBe(401)
  })

  it('WebSocketの接続でなければ400にする', async () => {
    const response = await invoke(`/api/overlay/lick/socket?key=${overlayKey}`, createEnv(), noFetch)

    expect(response.status).toBe(400)
  })

  it('WebSocketの接続なら、ペロペロを受け取る接続として配送先へ引き渡す', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await invoke(`/api/overlay/lick/socket?key=${overlayKey}`, createEnv(alertChannel), noFetch, { headers: { Upgrade: 'websocket' } })

    expect(response.status).toBe(200)
    expect(alertChannel.forwardedConnections.map((request) => new URL(request.url).searchParams.get('topic'))).toEqual(['lick'])
  })
})

describe('POST /api/admin/lick/demo', () => {
  /** 配信者としてログインした状態で呼ぶ。書き換えなので Origin も付ける（ブラウザが付けるのと同じ） */
  const callAsBroadcaster = async (env: Env, fetchImpl: typeof fetch, body?: unknown): Promise<Response> => {
    const session = await createSessionToken(env.TWITCH_BROADCASTER_ID, env.SESSION_SECRET, now)
    return invoke('/api/admin/lick/demo', env, fetchImpl, {
      method: 'POST',
      headers: { Cookie: `__Host-session=${session}`, Origin: site, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  it('ログインしていなければ401にし、押し出さない', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await invoke('/api/admin/lick/demo', createEnv(alertChannel), noFetch, { method: 'POST', headers: { Origin: site } })

    expect(response.status).toBe(401)
    expect(alertChannel.pushedLicks).toEqual([])
  })

  it('相手を指定しなければ、アイコンの無い試しの相手を舐める呼び出しを押し出し、押し出したものを返す', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await callAsBroadcaster(createEnv(alertChannel), noFetch, { userName: '' })

    expect(response.status).toBe(200)
    const call = alertChannel.pushedLicks[0]
    expect(call?.target).toEqual({ name: '視聴者（試し）', iconUrl: null })
    // 合成ページの読み取りがそのまま読める形で押し出す
    expect(parseLickCall(JSON.stringify(call))).toEqual(call)
    expect(await response.json()).toEqual(call)
  })

  it('相手のログイン名を渡せば、その人の表示名とアイコンを舐める', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await callAsBroadcaster(createEnv(alertChannel), twitchKnowingTarget, { userName: TARGET_LOGIN })

    expect(response.status).toBe(200)
    expect(alertChannel.pushedLicks[0]?.target).toEqual({ name: '山田花子', iconUrl: TARGET_ICON })
  })

  it('ログイン名の形でないユーザー名なら、押し出さずに400にする', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await callAsBroadcaster(createEnv(alertChannel), noFetch, { userName: 'やまだ はなこ' })

    expect(response.status).toBe(400)
    expect(alertChannel.pushedLicks).toEqual([])
  })

  it('Twitch にいないログイン名なら、押し出さずに404にする', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await callAsBroadcaster(createEnv(alertChannel), twitchKnowingTarget, { userName: 'nobody_here' })

    expect(response.status).toBe(404)
    expect(alertChannel.pushedLicks).toEqual([])
  })

  it('効果音を選んでいれば、トリガーと同じく音声のURL（オーバーレイ用キーつき）と音量を添えて押し出す', async () => {
    const alertChannel = createFakeAlertChannel()
    const env = createEnv(alertChannel)
    await saveLickSound(env.STORE, { sound: 'media-juru', volume: 0.8 })

    const response = await callAsBroadcaster(env, noFetch)

    expect(response.status).toBe(200)
    expect(alertChannel.pushedLicks[0]?.sound).toEqual({ sound: `/api/media/media-juru?key=${overlayKey}`, volume: 0.8 })
  })

  it('効果音を選んでいるのにオーバーレイ用キーが未発行なら、押し出さずに409にする', async () => {
    const alertChannel = createFakeAlertChannel()
    const env = createEnv(alertChannel, createFakeStore())
    await saveLickSound(env.STORE, { sound: 'media-juru', volume: 0.8 })

    const response = await callAsBroadcaster(env, noFetch)

    expect(response.status).toBe(409)
    expect(alertChannel.pushedLicks).toEqual([])
  })

  it('配送先が失敗したら502にする', async () => {
    const alertChannel = createFakeAlertChannel({ shouldFail: true })

    const response = await callAsBroadcaster(createEnv(alertChannel), noFetch)

    expect(response.status).toBe(502)
  })
})

describe('GET・PUT /api/admin/lick/sound', () => {
  /** 配信者としてログインした状態で呼ぶ。書き換えのときは Origin も付ける（ブラウザが付けるのと同じ） */
  const callAsBroadcaster = async (env: Env, init: RequestInit = {}): Promise<Response> => {
    const session = await createSessionToken(env.TWITCH_BROADCASTER_ID, env.SESSION_SECRET, now)
    return invoke('/api/admin/lick/sound', env, noFetch, { ...init, headers: { Cookie: `__Host-session=${session}`, Origin: site } })
  }

  /** ジュルジュルの音声と、写真の画像を上げておいた環境 */
  const createEnvWithMedia = async (): Promise<Env> => {
    const env = createEnv()
    await env.MEDIA.put('media-juru', new ArrayBuffer(8), { httpMetadata: { contentType: 'audio/mpeg' }, customMetadata: { name: 'juru.mp3' } })
    await env.MEDIA.put('media-photo', new ArrayBuffer(8), { httpMetadata: { contentType: 'image/png' }, customMetadata: { name: 'photo.png' } })
    return env
  }

  it('ログインしていなければ読ませない', async () => {
    const response = await invoke('/api/admin/lick/sound', createEnv(), noFetch)

    expect(response.status).toBe(401)
  })

  it('未保存なら、効果音を鳴らさない設定を返す', async () => {
    const response = await callAsBroadcaster(createEnv())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(DEFAULT_LICK_SOUND)
  })

  it('保存した設定を返し、次に読んだときも同じものを返す', async () => {
    const env = await createEnvWithMedia()
    const sound = { sound: 'media-juru', volume: 0.75 }

    const saved = await callAsBroadcaster(env, { method: 'PUT', body: JSON.stringify(sound) })
    const loaded = await callAsBroadcaster(env)

    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual(sound)
    expect(await loaded.json()).toEqual(sound)
  })

  it('音声でない素材を選んだ設定は、問題点つきの400で断って保存しない', async () => {
    const env = await createEnvWithMedia()

    const response = await callAsBroadcaster(env, { method: 'PUT', body: JSON.stringify({ sound: 'media-photo', volume: 0.5 }) })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { problems: string[] } }
    expect(body.error.problems).toEqual(['sound: 素材「media-photo」は音声ではありません'])
    expect(await loadLickSound(env.STORE)).toEqual(DEFAULT_LICK_SOUND)
  })
})
