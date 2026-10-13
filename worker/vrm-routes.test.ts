/**
 * VRMの演出の経路（vrm-routes.ts）のテスト
 *
 * - 合成ページの接続（GET /api/overlay/vrm/socket）は、VRMの演出を受け取る接続として配送先へ引き渡す
 * - 管理画面の試し再生（POST /api/admin/vrm/demo）は、ログインした配信者にだけ、選んである VRM の演出を押し出す。
 *   VRM を選んでいない・オーバーレイ用キーが未発行なら409にして押し出さない
 * - 出す VRM の設定（GET・PUT /api/admin/vrm/model）は、ログインした配信者にだけ読み書きさせ、VRM でない素材を選んだ設定は400で断る
 */
import { describe, expect, it } from 'vitest'
import { parseVrmCall } from '../src/vrm/call'
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
import { DEFAULT_VRM_MODEL, loadVrmModel, saveVrmModel } from './vrm-model'

const now = Date.parse('2026-10-13T12:00:00Z')
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

const invoke = (path: string, env: Env, init: RequestInit = {}) =>
  handleRequest(new Request(`${site}${path}`, init), env, {
    fetch: noFetch,
    now: () => now,
    wait: async () => {},
    waitUntil: () => undefined,
  })

/** 配信者としてログインした状態で呼ぶ。書き換えのときは Origin も付ける（ブラウザが付けるのと同じ） */
const callAsBroadcaster = async (path: string, env: Env, init: RequestInit = {}): Promise<Response> => {
  const session = await createSessionToken(env.TWITCH_BROADCASTER_ID, env.SESSION_SECRET, now)
  return invoke(path, env, { ...init, headers: { Cookie: `__Host-session=${session}`, Origin: site } })
}

describe('GET /api/overlay/vrm/socket', () => {
  it('オーバーレイ用キーが違えば断る', async () => {
    const response = await invoke('/api/overlay/vrm/socket?key=wrong-key-0123456789abcdefghijklmn', createEnv(), { headers: { Upgrade: 'websocket' } })

    expect(response.status).toBe(401)
  })

  it('WebSocketの接続でなければ400にする', async () => {
    const response = await invoke(`/api/overlay/vrm/socket?key=${overlayKey}`, createEnv())

    expect(response.status).toBe(400)
  })

  it('WebSocketの接続なら、VRMの演出を受け取る接続として配送先へ引き渡す', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await invoke(`/api/overlay/vrm/socket?key=${overlayKey}`, createEnv(alertChannel), { headers: { Upgrade: 'websocket' } })

    expect(response.status).toBe(200)
    expect(alertChannel.forwardedConnections.map((request) => new URL(request.url).searchParams.get('topic'))).toEqual(['vrm'])
  })
})

describe('POST /api/admin/vrm/demo', () => {
  const demo = (env: Env) => callAsBroadcaster('/api/admin/vrm/demo', env, { method: 'POST' })

  it('ログインしていなければ401にし、押し出さない', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await invoke('/api/admin/vrm/demo', createEnv(alertChannel), { method: 'POST', headers: { Origin: site } })

    expect(response.status).toBe(401)
    expect(alertChannel.pushedVrms).toEqual([])
  })

  it('選んである VRM のURL（オーバーレイ用キーつき）を種と一緒に押し出し、押し出したものを返す', async () => {
    const alertChannel = createFakeAlertChannel()
    const env = createEnv(alertChannel)
    // 検証（VRM であること）は vrm-model.test.ts が確かめるので、ここでは保存済みの設定として直接置く
    await saveVrmModel(env.STORE, { model: 'media-kanban' })

    const response = await demo(env)

    expect(response.status).toBe(200)
    const call = alertChannel.pushedVrms[0]
    expect(call?.model).toBe(`/api/media/media-kanban?key=${overlayKey}`)
    // 合成ページの読み取りがそのまま読める形で押し出す
    expect(parseVrmCall(JSON.stringify(call))).toEqual(call)
    expect(await response.json()).toEqual(call)
  })

  it('VRM を選んでいなければ、押し出さずに409にする', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await demo(createEnv(alertChannel))

    expect(response.status).toBe(409)
    expect(alertChannel.pushedVrms).toEqual([])
  })

  it('オーバーレイ用キーが未発行なら、押し出さずに409にする', async () => {
    const alertChannel = createFakeAlertChannel()
    const env = createEnv(alertChannel, createFakeStore())
    await saveVrmModel(env.STORE, { model: 'media-kanban' })

    const response = await demo(env)

    expect(response.status).toBe(409)
    expect(alertChannel.pushedVrms).toEqual([])
  })

  it('配送先が失敗したら502にする', async () => {
    const env = createEnv(createFakeAlertChannel({ shouldFail: true }))
    await saveVrmModel(env.STORE, { model: 'media-kanban' })

    const response = await demo(env)

    expect(response.status).toBe(502)
  })
})

describe('GET・PUT /api/admin/vrm/model', () => {
  /** 看板娘の VRM と、写真の画像を上げておいた環境 */
  const createEnvWithMedia = async (): Promise<Env> => {
    const env = createEnv()
    await env.MEDIA.put('media-kanban', new ArrayBuffer(8), { httpMetadata: { contentType: 'model/gltf-binary' }, customMetadata: { name: '看板娘.vrm' } })
    await env.MEDIA.put('media-photo', new ArrayBuffer(8), { httpMetadata: { contentType: 'image/png' }, customMetadata: { name: 'photo.png' } })
    return env
  }

  it('ログインしていなければ読ませない', async () => {
    const response = await invoke('/api/admin/vrm/model', createEnv())

    expect(response.status).toBe(401)
  })

  it('未保存なら、VRM を選んでいない設定を返す', async () => {
    const response = await callAsBroadcaster('/api/admin/vrm/model', createEnv())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(DEFAULT_VRM_MODEL)
  })

  it('保存した設定を返し、次に読んだときも同じものを返す', async () => {
    const env = await createEnvWithMedia()

    const saved = await callAsBroadcaster('/api/admin/vrm/model', env, { method: 'PUT', body: JSON.stringify({ model: 'media-kanban' }) })
    const loaded = await callAsBroadcaster('/api/admin/vrm/model', env)

    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({ model: 'media-kanban' })
    expect(await loaded.json()).toEqual({ model: 'media-kanban' })
  })

  it('VRM でない素材を選んだ設定は、問題点つきの400で断って保存しない', async () => {
    const env = await createEnvWithMedia()

    const response = await callAsBroadcaster('/api/admin/vrm/model', env, { method: 'PUT', body: JSON.stringify({ model: 'media-photo' }) })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { problems: string[] } }
    expect(body.error.problems).toEqual(['model: 素材「media-photo」は VRM ではありません'])
    expect(await loadVrmModel(env.STORE)).toEqual(DEFAULT_VRM_MODEL)
  })
})
