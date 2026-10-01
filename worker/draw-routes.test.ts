/**
 * 手書きの線の経路（/api/admin/draw/socket・/api/overlay/draw）のテスト
 *
 * 確かめるのは次の6点である。
 * - 描く画面（配信者のセッション）からの接続が、描く側として中継先へ引き渡されること
 * - 合成ページ（オーバーレイ用キー）からの接続が、見るだけとして引き渡されること
 * - ログインしていない接続・キーの誤った接続を断ること
 * - 別のサイトから開かれた接続を断ること（WebSocketはGETなので、書き換えのときのCSRF対策が効かない）
 * - 描いたものの保存と読み出しが、配信者のセッション（描く画面）とオーバーレイ用キー（合成ページ）の両方から通ること
 * - 検証に通らない線の保存を、問題点を添えて断ること
 */
import { describe, expect, it } from 'vitest'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeBucket } from './fake-bucket'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeTabChannel } from './fake-tab-channel'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeStore } from './fake-store'
import { handleRequest, type Env } from './index'
import { recordScreenCapture } from './screen-store'
import { recordStreamOnline } from './stats-store'
import { createSessionToken } from './session'

const now = Date.parse('2026-09-29T09:00:00Z')
const broadcasterId = '12345'
const site = 'https://hdad.example.com'
const issuedKey = 'issued-overlay-key-0123456789abcdefghij'

const createEnv = () => {
  const relayTarget = createFakeDrawChannel()
  const env = {
    STORE: createFakeStore({ 'overlay-key': issuedKey }),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: broadcasterId,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: createFakeAlertChannel().namespace,
    DRAW: relayTarget.namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    AI: createFakeWorkersAi(),
  } satisfies Env
  return { env, relayTarget }
}

const noTwitchFetch = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

const noWait = async (): Promise<void> => {}

const noDefer = (): void => {
  throw new Error('このテストでは、応答のあとに続く処理を使いません')
}

const invoke = (request: Request, env: Env) => handleRequest(request, env, { fetch: noTwitchFetch, now: () => now, wait: noWait, waitUntil: noDefer })

/** ブラウザがWebSocketをつなぐときと同じヘッダーで呼ぶ */
const connect = (env: Env, path: string, headers: Record<string, string> = {}) =>
  invoke(new Request(`${site}${path}`, { headers: { Upgrade: 'websocket', Origin: site, ...headers } }), env)

/** 配信者としてログインした状態でつなぐ */
const connectAsBroadcaster = async (env: Env, path: string, headers: Record<string, string> = {}) => {
  const session = await createSessionToken(broadcasterId, env.SESSION_SECRET, now)
  return connect(env, path, { Cookie: `__Host-session=${session}`, ...headers })
}

describe('GET /api/admin/draw/socket', () => {
  it('配信者の接続を、描く側として中継先へ引き渡す', async () => {
    const { env, relayTarget } = createEnv()

    const response = await connectAsBroadcaster(env, '/api/admin/draw/socket')

    expect(response.status).toBe(200)
    expect(relayTarget.forwardedConnections.map(({ url }) => new URL(url).searchParams.get('role'))).toEqual(['writer'])
  })

  it('ログインしていない接続は断る', async () => {
    const { env, relayTarget } = createEnv()

    const response = await connect(env, '/api/admin/draw/socket')

    expect(response.status).toBe(401)
    expect(relayTarget.forwardedConnections).toEqual([])
  })

  it('別のサイトから開かれた接続は断る', async () => {
    // WebSocketの接続はGETなので、書き換えのときの送信元の確認（requireAdmin）が効かない。
    // SameSite=Lax のクッキーは別サイトからのWebSocketには付かないが、ブラウザの決まりだけに頼らず確かめる
    const { env, relayTarget } = createEnv()

    const response = await connectAsBroadcaster(env, '/api/admin/draw/socket', { Origin: 'https://evil.example.com' })

    expect(response.status).toBe(403)
    expect(relayTarget.forwardedConnections).toEqual([])
  })

  it('WebSocketでない要求は断る', async () => {
    const { env } = createEnv()
    const session = await createSessionToken(broadcasterId, env.SESSION_SECRET, now)

    const response = await invoke(new Request(`${site}/api/admin/draw/socket`, { headers: { Cookie: `__Host-session=${session}`, Origin: site } }), env)

    expect(response.status).toBe(400)
  })
})

describe('GET /api/overlay/draw', () => {
  it('オーバーレイ用キーの合う接続を、見るだけとして中継先へ引き渡す', async () => {
    const { env, relayTarget } = createEnv()

    const response = await connect(env, `/api/overlay/draw?key=${issuedKey}`)

    expect(response.status).toBe(200)
    expect(relayTarget.forwardedConnections.map(({ url }) => new URL(url).searchParams.get('role'))).toEqual(['viewer'])
  })

  it('オーバーレイ用キーが違う接続は断る', async () => {
    const { env, relayTarget } = createEnv()

    const response = await connect(env, '/api/overlay/draw?key=違うキー')

    expect(response.status).toBe(401)
    expect(relayTarget.forwardedConnections).toEqual([])
  })

  it('WebSocketでない要求は断る', async () => {
    const { env } = createEnv()

    const response = await invoke(new Request(`${site}/api/overlay/draw?key=${issuedKey}`), env)

    expect(response.status).toBe(400)
  })
})

/** 描く画面が保存のときに送るのと同じ形で呼ぶ */
const save = (env: Env, body: unknown, headers: Record<string, string> = {}) =>
  invoke(
    new Request(`${site}/api/admin/draw/strokes`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: site, ...headers },
      body: JSON.stringify(body),
    }),
    env,
  )

/** 配信者としてログインした状態で保存する */
const saveAsBroadcaster = async (env: Env, body: unknown) => {
  const session = await createSessionToken(broadcasterId, env.SESSION_SECRET, now)
  return save(env, body, { Cookie: `__Host-session=${session}` })
}

/** 配信画面に引いた線1本 */
const drawnStrokes = { id: '線1', points: [{ x: 0.1, y: 0.2 }], color: 'red', width: 'bold' }

describe('PUT・GET /api/admin/draw/strokes', () => {
  it('配信者が描いた線を保存し、同じ形で読み出せる', async () => {
    // OBSのブラウザソースを作り直しても描いたものが残るように、引き終えた線をKVへ写す
    const { env } = createEnv()
    const session = await createSessionToken(broadcasterId, env.SESSION_SECRET, now)

    const saveResponse = await saveAsBroadcaster(env, { strokes: [drawnStrokes] })
    const readResponse = await invoke(new Request(`${site}/api/admin/draw/strokes`, { headers: { Cookie: `__Host-session=${session}` } }), env)

    expect(saveResponse.status).toBe(200)
    expect(await readResponse.json()).toEqual({ strokes: [drawnStrokes] })
  })

  it('ログインしていない保存は断る', async () => {
    const { env } = createEnv()

    const response = await save(env, { strokes: [drawnStrokes] })

    expect(response.status).toBe(401)
  })

  it('検証に通らない線は、問題点を添えて断る', async () => {
    const { env } = createEnv()

    const response = await saveAsBroadcaster(env, { strokes: [{ ...drawnStrokes, color: 'magenta' }] })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { problems: [expect.stringContaining('strokes[0]')] } })
  })
})

describe('GET /api/overlay/draw/strokes', () => {
  it('合成ページがオーバーレイ用キーで、保存されている線を読める', async () => {
    const { env } = createEnv()
    await saveAsBroadcaster(env, { strokes: [drawnStrokes] })

    const response = await invoke(new Request(`${site}/api/overlay/draw/strokes?key=${issuedKey}`), env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ strokes: [drawnStrokes] })
  })

  it('一度も描いていなければ、線が無い状態を返す', async () => {
    const { env } = createEnv()

    const response = await invoke(new Request(`${site}/api/overlay/draw/strokes?key=${issuedKey}`), env)

    expect(await response.json()).toEqual({ strokes: [] })
  })

  it('オーバーレイ用キーが違う読み出しは断る', async () => {
    const { env } = createEnv()

    const response = await invoke(new Request(`${site}/api/overlay/draw/strokes?key=違うキー`), env)

    expect(response.status).toBe(401)
  })
})

describe('GET /api/admin/draw/background', () => {
  const capturedAt = Date.parse('2026-09-29T08:59:00Z')
  const imageId = 'abcdef0123456789abcdef0123456789'
  const imageUrl = `https://i.gyazo.com/${imageId}.png`

  /** Gyazo の1枚の情報を返し、呼ばれた回数を数える fetch */
  const countGyazo = () => {
    const calledUrls: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calledUrls.push(String(input))
      return Response.json({ image_id: imageId, url: imageUrl, access_policy: 'anyone' })
    }) as typeof fetch
    return { fetchImpl, calledUrls }
  }

  /** 配信者としてログインした状態で背景を読む */
  const readBackgroundAsBroadcaster = async (env: Env, fetchImpl: typeof fetch, headers: Record<string, string> = {}) => {
    const session = await createSessionToken(broadcasterId, env.SESSION_SECRET, now)
    return handleRequest(new Request(`${site}/api/admin/draw/background`, { headers: { Cookie: `__Host-session=${session}`, ...headers } }), env, {
      fetch: fetchImpl,
      now: () => now,
      wait: noWait,
      waitUntil: noDefer,
    })
  }

  /** 配信中に画面の取り込みが1枚撮った状態にする */
  const captureBeforehand = async (env: Env) => {
    await recordStreamOnline(env.DB, { id: 'session-1', startedAt: capturedAt - 60_000 })
    await recordScreenCapture(env.DB, imageId, capturedAt)
  }

  const envWithGyazoToken = () => {
    const { env } = createEnv()
    return { ...env, GYAZO_ACCESS_TOKEN: 'テスト用のGyazoトークン' } satisfies Env
  }

  it('最後に撮った1枚の画像のURLと撮った時刻を返す。手元に残さないよう指示する', async () => {
    const env = envWithGyazoToken()
    await captureBeforehand(env)

    const response = await readBackgroundAsBroadcaster(env, countGyazo().fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ imageId, capturedAt, url: imageUrl })
    expect(response.headers.get('ETag')).toBe(`"${imageId}"`)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('手元と同じ1枚なら、Gyazo を呼ばずに304を返す', async () => {
    const env = envWithGyazoToken()
    await captureBeforehand(env)
    const { fetchImpl, calledUrls } = countGyazo()

    const response = await readBackgroundAsBroadcaster(env, fetchImpl, { 'If-None-Match': `"${imageId}"` })

    expect(response.status).toBe(304)
    expect(calledUrls).toEqual([])
  })

  it('まだ1枚も撮っていなければ204を返す', async () => {
    const response = await readBackgroundAsBroadcaster(envWithGyazoToken(), countGyazo().fetchImpl)

    expect(response.status).toBe(204)
  })

  it('Gyazo のアクセストークンが無ければ失敗させる（黙って背景なしにしない）', async () => {
    const { env } = createEnv()
    await captureBeforehand(env)

    const response = await readBackgroundAsBroadcaster(env, countGyazo().fetchImpl)

    expect(response.status).toBe(500)
  })

  it('ログインしていなければ断る', async () => {
    const { env } = createEnv()

    const response = await invoke(new Request(`${site}/api/admin/draw/background`), env)

    expect(response.status).toBe(401)
  })
})
