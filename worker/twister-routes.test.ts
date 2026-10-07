/**
 * ツイスターの経路（twister-routes.ts）のテスト
 *
 * - 合成ページの接続（GET /api/overlay/twister/socket）は、ツイスターを受け取る接続として配送先へ引き渡す
 * - 管理画面の試し再生（POST /api/admin/twister/demo）は、ログインした配信者にだけ、試しの相手と配信者の対戦を押し出す。
 *   配信者のアイコンは Twitch から引き、引けなければ押し出さずに 502 にする（顔の無い対戦を黙って流さない）
 * - 本文で相手のログイン名を渡せば、その人がレイドしてきたものとみなし、Twitch で引いた表示名とアイコンで対戦する。
 *   ログイン名の形でなければ400、Twitch にいなければ404にし、どちらも押し出さない
 * - 試し再生もレイドと同じ BGM の設定を添えて押し出す。BGM を選んでいるのにオーバーレイ用キーが未発行なら409にして押し出さない
 * - BGM の設定（GET・PUT /api/admin/twister/sound）は、ログインした配信者にだけ読み書きさせ、音声でない素材を選んだ設定は400で断る
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
import { DEFAULT_TWISTER_SOUND, loadTwisterSound, saveTwisterSound } from './twister-sound'

const now = Date.parse('2026-10-06T12:00:00Z')
const site = 'https://hdad.example.com'
const overlayKey = 'issued-overlay-key-0123456789abcdefghij'
const BROADCASTER_ID = '12345'
const BROADCASTER_ICON = 'https://static-cdn.jtvnw.net/jtv_user_pictures/tanenobu.png'

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

const RAIDER_LOGIN = 'yamada_hanako'
const RAIDER_ICON = 'https://static-cdn.jtvnw.net/jtv_user_pictures/yamada.png'

/** 配信者のアイコンに加えて、ログイン名 yamada_hanako の配信者（表示名は山田花子）を返す Twitch の代役。ほかのログイン名はいないことにする */
const twitchKnowingRaider: typeof fetch = async (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.origin + url.pathname === 'https://api.twitch.tv/helix/users' && url.searchParams.has('login')) {
    if (url.searchParams.get('login') !== RAIDER_LOGIN) return Response.json({ data: [] })
    return Response.json({
      data: [{ id: '1111', login: RAIDER_LOGIN, display_name: '山田花子', description: '', profile_image_url: RAIDER_ICON }],
    })
  }
  return twitchReturningBroadcasterIcon(request)
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
  const callAsBroadcaster = async (env: Env, fetchImpl: typeof fetch, body?: unknown): Promise<Response> => {
    const session = await createSessionToken(env.TWITCH_BROADCASTER_ID, env.SESSION_SECRET, now)
    return invoke('/api/admin/twister/demo', env, fetchImpl, {
      method: 'POST',
      headers: { Cookie: `__Host-session=${session}`, Origin: site, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
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
    // BGM を選んでいなければ、流さない設定のまま押し出す
    expect(call?.sound).toEqual(DEFAULT_TWISTER_SOUND)
  })

  it('BGM を選んでいれば、レイドと同じく音声のURL（オーバーレイ用キーつき）と音量を添えて押し出す', async () => {
    const alertChannel = createFakeAlertChannel()
    const env = createEnv(alertChannel)
    await saveTwisterSound(env.STORE, { bgm: 'media-taisen', bgmVolume: 0.4 })

    const response = await callAsBroadcaster(env, twitchReturningBroadcasterIcon)

    expect(response.status).toBe(200)
    expect(alertChannel.pushedTwisters[0]?.sound).toEqual({ bgm: `/api/media/media-taisen?key=${overlayKey}`, bgmVolume: 0.4 })
  })

  it('BGM を選んでいるのにオーバーレイ用キーが未発行なら、押し出さずに409にする', async () => {
    const alertChannel = createFakeAlertChannel()
    const env = createEnv(alertChannel, createFakeStore())
    await saveTwisterSound(env.STORE, { bgm: 'media-taisen', bgmVolume: 0.4 })

    const response = await callAsBroadcaster(env, twitchReturningBroadcasterIcon)

    expect(response.status).toBe(409)
    expect(alertChannel.pushedTwisters).toEqual([])
  })

  it('ユーザー名が空なら、試しの相手で対戦する', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await callAsBroadcaster(createEnv(alertChannel), twitchReturningBroadcasterIcon, { userName: '' })

    expect(response.status).toBe(200)
    expect(alertChannel.pushedTwisters[0]?.players[0]).toEqual({ name: 'レイドした人（試し）', iconUrl: null })
  })

  it('相手のログイン名を渡せば、その人の表示名とアイコンで対戦する', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await callAsBroadcaster(createEnv(alertChannel), twitchKnowingRaider, { userName: RAIDER_LOGIN })

    expect(response.status).toBe(200)
    expect(alertChannel.pushedTwisters[0]?.players).toEqual([
      { name: '山田花子', iconUrl: RAIDER_ICON },
      { name: '配信者', iconUrl: BROADCASTER_ICON },
    ])
  })

  it('ログイン名の形でないユーザー名なら、押し出さずに400にする', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await callAsBroadcaster(createEnv(alertChannel), noFetch, { userName: 'やまだ はなこ' })

    expect(response.status).toBe(400)
    expect(alertChannel.pushedTwisters).toEqual([])
  })

  it('Twitch にいないログイン名なら、押し出さずに404にする', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await callAsBroadcaster(createEnv(alertChannel), twitchKnowingRaider, { userName: 'nobody_here' })

    expect(response.status).toBe(404)
    expect(alertChannel.pushedTwisters).toEqual([])
  })

  it('本文が JSON でなければ、押し出さずに400にする', async () => {
    const alertChannel = createFakeAlertChannel()
    const session = await createSessionToken(BROADCASTER_ID, 'テスト用のセッション秘密鍵', now)

    const response = await invoke('/api/admin/twister/demo', createEnv(alertChannel), noFetch, {
      method: 'POST',
      headers: { Cookie: `__Host-session=${session}`, Origin: site },
      body: 'yamada_hanako',
    })

    expect(response.status).toBe(400)
    expect(alertChannel.pushedTwisters).toEqual([])
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

describe('GET・PUT /api/admin/twister/sound', () => {
  /** 配信者としてログインした状態で呼ぶ。書き換えのときは Origin も付ける（ブラウザが付けるのと同じ） */
  const callAsBroadcaster = async (env: Env, init: RequestInit = {}): Promise<Response> => {
    const session = await createSessionToken(env.TWITCH_BROADCASTER_ID, env.SESSION_SECRET, now)
    return invoke('/api/admin/twister/sound', env, noFetch, { ...init, headers: { Cookie: `__Host-session=${session}`, Origin: site } })
  }

  /** 対戦の曲（音声）と、マットの画像を上げておいた環境 */
  const createEnvWithMedia = async (): Promise<Env> => {
    const env = createEnv()
    await env.MEDIA.put('media-taisen', new ArrayBuffer(8), { httpMetadata: { contentType: 'audio/mpeg' }, customMetadata: { name: 'taisen.mp3' } })
    await env.MEDIA.put('media-mat', new ArrayBuffer(8), { httpMetadata: { contentType: 'image/png' }, customMetadata: { name: 'mat.png' } })
    return env
  }

  it('ログインしていなければ読ませない', async () => {
    const response = await invoke('/api/admin/twister/sound', createEnv(), noFetch)

    expect(response.status).toBe(401)
  })

  it('未保存なら、BGM を流さない設定を返す', async () => {
    const response = await callAsBroadcaster(createEnv())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(DEFAULT_TWISTER_SOUND)
  })

  it('保存した設定を返し、次に読んだときも同じものを返す', async () => {
    const env = await createEnvWithMedia()
    const sound = { bgm: 'media-taisen', bgmVolume: 0.25 }

    const saved = await callAsBroadcaster(env, { method: 'PUT', body: JSON.stringify(sound) })
    const loaded = await callAsBroadcaster(env)

    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual(sound)
    expect(await loaded.json()).toEqual(sound)
  })

  it('音声でない素材を選んだ設定は、問題点つきの400で断って保存しない', async () => {
    const env = await createEnvWithMedia()

    const response = await callAsBroadcaster(env, { method: 'PUT', body: JSON.stringify({ bgm: 'media-mat', bgmVolume: 0.3 }) })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { problems: string[] } }
    expect(body.error.problems).toEqual(['bgm: 素材「media-mat」は音声ではありません'])
    expect(await loadTwisterSound(env.STORE)).toEqual(DEFAULT_TWISTER_SOUND)
  })
})
