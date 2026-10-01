/**
 * 視聴者の記録の読み書き用API（/api/admin/viewers）のテスト
 *
 * KV・R2・D1を差し替え、handleRequest を通して確かめる。ログインの要求と、
 * 書き換えのときの送信元の確認（CSRF対策）も合わせて確かめる。
 */
import { describe, expect, it } from 'vitest'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeTabChannel } from './fake-tab-channel'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeBucket } from './fake-bucket'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'
import { listViewers, recordViewerMessage } from './viewer-store'

const NOW = Date.parse('2026-09-21T12:10:00Z')
const BROADCASTER_ID = '12345'
const site = 'https://hdad.example.com'

const createEnv = () => {
  const db = createFakeDatabase()
  const env = {
    STORE: createFakeStore(),
    MEDIA: createFakeBucket(),
    DB: db,
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
    AI: createFakeWorkersAi(),
  } satisfies Env
  return { env, db }
}

const noTwitchCalls = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

const noWait = async (): Promise<void> => {}

/**
 * これらの経路は応答のあとに続く処理（waitUntil）を使わない。
 * 黙って捨てると気づけなくなるので、預けられたら失敗させる（使うのは webhook-routes.test.ts だけ）。
 */
const noDefer = (): void => {
  throw new Error('このテストでは、応答のあとに続く処理を使いません')
}

const invoke = (request: Request, env: Env) => handleRequest(request, env, { fetch: noTwitchCalls, now: () => NOW, wait: noWait, waitUntil: noDefer })

/** 配信者としてログインした状態で呼ぶ。書き換えのときは Origin も付ける（ブラウザが付けるのと同じ） */
const invokeAsBroadcaster = async (env: Env, path: string, init: RequestInit = {}): Promise<Response> => {
  const session = await createSessionToken(BROADCASTER_ID, env.SESSION_SECRET, NOW)
  const headers: Record<string, string> = { Cookie: `__Host-session=${session}` }
  if (init.method !== undefined && init.method !== 'GET') headers.Origin = site
  return invoke(new Request(`${site}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } }), env)
}

/** 発言を1件記録する（一覧に出す人を用意するため） */
const recordMessage = (env: Env, userId: string, login: string, displayName: string, at: number) =>
  recordViewerMessage(env.DB, { userId, login, displayName, badges: ['subscriber'], messageId: `message-${userId}` }, at)

describe('GET /api/admin/viewers', () => {
  it('記録のある人を、最後に発言した順で返す', async () => {
    const { env } = createEnv()
    await recordMessage(env, '100', 'hanako', '花子', NOW - 60 * 1000)
    await recordMessage(env, '200', 'taro', '太郎', NOW)

    const response = await invokeAsBroadcaster(env, '/api/admin/viewers')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      viewers: [
        { userId: '200', login: 'taro', displayName: '太郎', messageCount: 1, badges: ['subscriber'], note: '' },
        { userId: '100', login: 'hanako', displayName: '花子' },
      ],
    })
  })

  it('search でログイン名の前方一致に絞り込む', async () => {
    const { env } = createEnv()
    await recordMessage(env, '100', 'hanako', '花子', NOW - 60 * 1000)
    await recordMessage(env, '200', 'taro', '太郎', NOW)

    const response = await invokeAsBroadcaster(env, '/api/admin/viewers?search=han')

    expect(await response.json()).toMatchObject({ viewers: [{ login: 'hanako' }] })
  })

  it('before で続きを読める', async () => {
    const { env } = createEnv()
    await recordMessage(env, '100', 'hanako', '花子', NOW - 60 * 1000)
    await recordMessage(env, '200', 'taro', '太郎', NOW)

    const response = await invokeAsBroadcaster(env, `/api/admin/viewers?before=${encodeURIComponent('2026-09-21T12:10:00.000Z')}`)

    expect(await response.json()).toMatchObject({ viewers: [{ login: 'hanako' }] })
  })

  it('beforeUserId で、同じ日時の人のどこまで読んだかを渡せる', async () => {
    const { env } = createEnv()
    await recordMessage(env, '100', 'hanako', '花子', NOW)
    await recordMessage(env, '200', 'taro', '太郎', NOW)

    const before = encodeURIComponent('2026-09-21T12:10:00.000Z')
    const response = await invokeAsBroadcaster(env, `/api/admin/viewers?before=${before}&beforeUserId=200`)

    expect(await response.json()).toMatchObject({ viewers: [{ userId: '100' }] })
  })

  it('limit が数でなければ400にする（黙って既定に戻さない）', async () => {
    const { env } = createEnv()

    const response = await invokeAsBroadcaster(env, '/api/admin/viewers?limit=たくさん')

    expect(response.status).toBe(400)
  })

  it('ログインしていなければ401にする', async () => {
    const { env } = createEnv()

    const response = await invoke(new Request(`${site}/api/admin/viewers`), env)

    expect(response.status).toBe(401)
  })
})

describe('PATCH /api/admin/viewers/:userId', () => {
  const writeMemo = (env: Env, userId: string, note: unknown) =>
    invokeAsBroadcaster(env, `/api/admin/viewers/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    })

  it('メモを保存する', async () => {
    const { env } = createEnv()
    await recordMessage(env, '100', 'hanako', '花子', NOW)

    const response = await writeMemo(env, '100', 'ゲームの話をよくする人')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ userId: '100', note: 'ゲームの話をよくする人' })
    expect((await listViewers(env.DB, {}))[0]?.note).toBe('ゲームの話をよくする人')
  })

  it('記録のない人なら404にする', async () => {
    const { env } = createEnv()

    const response = await writeMemo(env, '999', 'メモ')

    expect(response.status).toBe(404)
  })

  it('メモが文字列でなければ400にする', async () => {
    const { env } = createEnv()
    await recordMessage(env, '100', 'hanako', '花子', NOW)

    const response = await writeMemo(env, '100', 123)

    expect(response.status).toBe(400)
  })

  it('メモが長すぎれば400にする', async () => {
    const { env } = createEnv()
    await recordMessage(env, '100', 'hanako', '花子', NOW)

    const response = await writeMemo(env, '100', 'あ'.repeat(2001))

    expect(response.status).toBe(400)
  })

  it('Origin が違えば403にする（CSRF対策）', async () => {
    const { env } = createEnv()
    await recordMessage(env, '100', 'hanako', '花子', NOW)
    const session = await createSessionToken(BROADCASTER_ID, env.SESSION_SECRET, NOW)

    const response = await invoke(
      new Request(`${site}/api/admin/viewers/100`, {
        method: 'PATCH',
        headers: { Cookie: `__Host-session=${session}`, Origin: 'https://warui.example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'メモ' }),
      }),
      env,
    )

    expect(response.status).toBe(403)
  })
})

describe('DELETE /api/admin/viewers/:userId', () => {
  it('記録を消す（本人から求められたときに応じられるようにするため）', async () => {
    const { env } = createEnv()
    await recordMessage(env, '100', 'hanako', '花子', NOW)

    const response = await invokeAsBroadcaster(env, '/api/admin/viewers/100', { method: 'DELETE' })

    expect(response.status).toBe(204)
    expect(await listViewers(env.DB, {})).toEqual([])
  })

  it('記録のない人なら404にする', async () => {
    const { env } = createEnv()

    const response = await invokeAsBroadcaster(env, '/api/admin/viewers/999', { method: 'DELETE' })

    expect(response.status).toBe(404)
  })
})
