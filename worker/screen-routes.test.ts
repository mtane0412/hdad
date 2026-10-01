/**
 * 配信画面の取り込みの経路（/api/admin/screen・/api/overlay/screen）のテスト
 *
 * KV・R2・D1と外への通信を差し替え、handleRequest を通して確かめる。特に重要なのは次の5点である。
 * - 裏方のページ（オーバーレイ用キー）が、管理画面（セッション）で保存したつなぎ先の設定を読めること
 * - 裏方のページに、撮るのに要らない設定（上げ先のコレクション）は渡さないこと
 * - 撮った1枚が Gyazo へ渡り、その画像IDが記録されること
 * - 配信していなければ Gyazo へ上げないこと（配信前の準備画面を外へ出さないため）
 * - Gyazo のアクセストークンが無いとき、黙って捨てずに失敗させること（Fail-Fast）
 * - 画像でない本文や大きすぎる本文を、読み込む前に拒むこと
 */
import { describe, expect, it } from 'vitest'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeTabChannel } from './fake-tab-channel'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeBucket } from './fake-bucket'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'
import { handleRequest, type Env } from './index'
import { DEFAULT_SCREEN_SETTINGS } from './screen-config'
import { createSessionToken } from './session'
import { recordStreamOnline } from './stats-store'

const now = Date.parse('2026-09-28T12:05:00Z')
const streamStartedAt = Date.parse('2026-09-28T12:00:00Z')
const broadcasterId = '12345'
const site = 'https://hdad.example.com'
const issuedKey = 'issued-overlay-key-0123456789abcdefghij'
const imageId = 'abcdef0123456789abcdef0123456789'
const sessionSecret = 'テスト用のセッション秘密鍵'

/** @param gyazoToken null を渡すと、トークンが未設定の環境になる */
const createEnv = (gyazoToken: string | null = 'テスト用のGyazoトークン') => {
  const env = {
    STORE: createFakeStore({ 'overlay-key': issuedKey }),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: broadcasterId,
    SESSION_SECRET: sessionSecret,
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: createFakeAlertChannel().namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    AI: createFakeWorkersAi(),
    GYAZO_ACCESS_TOKEN: gyazoToken ?? undefined,
  } satisfies Env
  return { env }
}

const noFetch = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

const noWait = async (): Promise<void> => {}
const noDefer = (): void => {
  throw new Error('このテストでは、応答のあとに続く処理を使いません')
}

const call = (request: Request, env: Env, fetchImpl = noFetch) =>
  handleRequest(request, env, { fetch: fetchImpl, now: () => now, wait: noWait, waitUntil: noDefer })

const loggedInHeaders = async (extra: Record<string, string> = {}): Promise<Record<string, string>> => ({
  Cookie: `__Host-session=${await createSessionToken(broadcasterId, sessionSecret, now)}`,
  ...extra,
})

/** Gyazo へのアップロードを覚えたうえで、決めておいた画像IDを返す fetch を作る */
const recordGyazo = () => {
  const received: { url: string; body: FormData }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    received.push({ url: String(input), body: init?.body as FormData })
    return Response.json({ image_id: imageId, permalink_url: `https://gyazo.com/${imageId}` })
  }) as typeof fetch
  return { fetchImpl, received }
}

/** 管理画面から設定を保存する */
const saveConfig = async (env: Env, config: Record<string, unknown>) =>
  call(
    new Request(`${site}/api/admin/screen`, {
      method: 'PUT',
      headers: await loggedInHeaders({ Origin: site, 'Content-Type': 'application/json' }),
      body: JSON.stringify(config),
    }),
    env,
  )

/** 正しく埋まった設定（保存のテストで使う） */
const configToSave = {
  host: '127.0.0.1',
  port: 4456,
  password: 'obsのパスワード',
  intervalSeconds: 90,
  collectionId: 'f19e74cebe47c9cadad31b6790098eac',
}

const imageBody = (): Uint8Array => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

const sendCapture = (body: BodyInit, contentType = 'image/png') =>
  new Request(`${site}/api/overlay/screen?key=${issuedKey}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  })

describe('GET /api/overlay/screen', () => {
  it('未保存なら既定のつなぎ先を返す', async () => {
    const { env } = createEnv()
    const response = await call(new Request(`${site}/api/overlay/screen?key=${issuedKey}`), env)

    expect(response.status).toBe(200)
    const { host, port, password, intervalSeconds } = DEFAULT_SCREEN_SETTINGS
    expect(await response.json()).toEqual({ host, port, password, intervalSeconds })
  })

  it('オーバーレイ用キーが違えば拒む', async () => {
    const { env } = createEnv()
    const response = await call(new Request(`${site}/api/overlay/screen?key=違うキー`), env)

    expect(response.status).toBe(401)
  })

  it('管理画面で保存したつなぎ先を、裏方のページが読める', async () => {
    const { env } = createEnv()
    expect((await saveConfig(env, configToSave)).status).toBe(200)

    const response = await call(new Request(`${site}/api/overlay/screen?key=${issuedKey}`), env)
    expect(await response.json()).toEqual({ host: '127.0.0.1', port: 4456, password: 'obsのパスワード', intervalSeconds: 90 })
  })

  it('上げ先のコレクションは裏方のページに渡さない（撮るのに要らないため）', async () => {
    const { env } = createEnv()
    await saveConfig(env, configToSave)

    const response = await call(new Request(`${site}/api/overlay/screen?key=${issuedKey}`), env)
    expect(await response.json()).not.toHaveProperty('collectionId')
  })

  it('設定に問題があれば、問題点を並べて拒む', async () => {
    const { env } = createEnv()
    const response = await saveConfig(env, { host: 'obs.example.com', port: 0, password: '', intervalSeconds: 1, collectionId: '' })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { problems: string[] } }
    expect(body.error.problems).toHaveLength(3)
  })
})

describe('POST /api/overlay/screen', () => {
  it('配信中なら Gyazo へ上げ、画像IDを記録する', async () => {
    const { env } = createEnv()
    await recordStreamOnline(env.DB, { id: 'session-1', startedAt: streamStartedAt })
    const { fetchImpl, received } = recordGyazo()

    const response = await call(sendCapture(imageBody()), env, fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ recorded: true, imageId })
    expect(received[0]?.url).toBe('https://upload.gyazo.com/api/upload')
  })

  it('コレクションを指定してあれば、そのコレクションへ上げる', async () => {
    const { env } = createEnv()
    await saveConfig(env, configToSave)
    await recordStreamOnline(env.DB, { id: 'session-1', startedAt: streamStartedAt })
    const { fetchImpl, received } = recordGyazo()

    await call(sendCapture(imageBody()), env, fetchImpl)

    expect(received[0]?.body?.get('collection_id')).toBe('f19e74cebe47c9cadad31b6790098eac')
  })

  it('コレクションを指定していなければ、コレクションの指定を送らない', async () => {
    const { env } = createEnv()
    await recordStreamOnline(env.DB, { id: 'session-1', startedAt: streamStartedAt })
    const { fetchImpl, received } = recordGyazo()

    await call(sendCapture(imageBody()), env, fetchImpl)

    expect(received[0]?.body?.has('collection_id')).toBe(false)
  })

  it('配信していなければ Gyazo へ上げず、記録しなかったことを知らせる', async () => {
    const { env } = createEnv()
    const { fetchImpl, received } = recordGyazo()

    const response = await call(sendCapture(imageBody()), env, fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ recorded: false, imageId: null })
    expect(received).toEqual([])
  })

  it('Gyazo のアクセストークンが無ければ失敗させる', async () => {
    const { env } = createEnv(null)
    await recordStreamOnline(env.DB, { id: 'session-1', startedAt: streamStartedAt })

    const response = await call(sendCapture(imageBody()), env)

    expect(response.status).toBe(500)
    expect((await response.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'gyazo-token-missing' } })
  })

  it('画像でない本文を拒む', async () => {
    const { env } = createEnv()
    await recordStreamOnline(env.DB, { id: 'session-1', startedAt: streamStartedAt })

    const response = await call(sendCapture('画像ではない本文', 'text/plain'), env)

    expect(response.status).toBe(415)
  })

  it('空の本文を拒む', async () => {
    const { env } = createEnv()
    await recordStreamOnline(env.DB, { id: 'session-1', startedAt: streamStartedAt })

    const response = await call(sendCapture(new Uint8Array()), env)

    expect(response.status).toBe(400)
  })

  it('大きすぎると申告された本文は、読み込む前に拒む', async () => {
    const { env } = createEnv()
    await recordStreamOnline(env.DB, { id: 'session-1', startedAt: streamStartedAt })

    const response = await call(
      new Request(`${site}/api/overlay/screen?key=${issuedKey}`, {
        method: 'POST',
        // 本文の長さの申告（Content-Length）だけで拒めることを確かめる（実際に大きな本文を作らない）
        headers: { 'Content-Type': 'image/png', 'Content-Length': String(9 * 1024 * 1024) },
        body: imageBody(),
      }),
      env,
    )

    expect(response.status).toBe(413)
  })

  it('オーバーレイ用キーが違えば拒む', async () => {
    const { env } = createEnv()
    const response = await call(
      new Request(`${site}/api/overlay/screen?key=違うキー`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: imageBody(),
      }),
      env,
    )

    expect(response.status).toBe(401)
  })
})
