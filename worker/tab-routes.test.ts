/**
 * タブの映像の連絡の経路（/api/admin/tab/socket・/api/overlay/tab）のテスト
 *
 * 確かめるのは次の4点である。
 * - 送り手（配信者のセッション）からの接続が、送り手として中継先へ引き渡されること
 * - 合成ページ（オーバーレイ用キー）からの接続が、合成ページとして引き渡されること
 * - ログインしていない接続・キーの誤った接続を断ること
 * - 別のサイトから開かれた接続を断ること（WebSocketはGETなので、書き換えのときのCSRF対策が効かない）
 */
import { describe, expect, it } from 'vitest'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeBucket } from './fake-bucket'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeStore } from './fake-store'
import { createFakeTabChannel } from './fake-tab-channel'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'

const now = Date.parse('2026-10-01T10:00:00Z')
const broadcasterId = '12345'
const site = 'https://hdad.example.com'
const issuedKey = 'issued-overlay-key-0123456789abcdefghij'

const createEnv = () => {
  const relayTarget = createFakeTabChannel()
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
    DRAW: createFakeDrawChannel().namespace,
    TAB: relayTarget.namespace,
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

/** 中継先へ引き渡された接続の役割 */
const forwardedRoles = (relayTarget: ReturnType<typeof createFakeTabChannel>) =>
  relayTarget.forwardedConnections.map(({ url }) => new URL(url).searchParams.get('role'))

describe('GET /api/admin/tab/socket', () => {
  it('配信者の接続を、送り手として中継先へ引き渡す', async () => {
    const { env, relayTarget } = createEnv()

    const response = await connectAsBroadcaster(env, '/api/admin/tab/socket')

    expect(response.status).toBe(200)
    expect(forwardedRoles(relayTarget)).toEqual(['sender'])
  })

  it('ログインしていない接続は断る', async () => {
    const { env, relayTarget } = createEnv()

    const response = await connect(env, '/api/admin/tab/socket')

    expect(response.status).toBe(401)
    expect(relayTarget.forwardedConnections).toEqual([])
  })

  it('別のサイトから開かれた接続は断る', async () => {
    // 別サイトに開かせた接続が送り手を名乗り、合成ページへ別の映像を送り込めないようにする
    const { env, relayTarget } = createEnv()

    const response = await connectAsBroadcaster(env, '/api/admin/tab/socket', { Origin: 'https://evil.example.com' })

    expect(response.status).toBe(403)
    expect(relayTarget.forwardedConnections).toEqual([])
  })

  it('WebSocketでない要求は断る', async () => {
    const { env } = createEnv()
    const session = await createSessionToken(broadcasterId, env.SESSION_SECRET, now)

    const response = await invoke(new Request(`${site}/api/admin/tab/socket`, { headers: { Cookie: `__Host-session=${session}`, Origin: site } }), env)

    expect(response.status).toBe(400)
  })
})

describe('GET /api/overlay/tab', () => {
  it('オーバーレイ用キーの合う接続を、合成ページとして中継先へ引き渡す', async () => {
    const { env, relayTarget } = createEnv()

    const response = await connect(env, `/api/overlay/tab?key=${issuedKey}`)

    expect(response.status).toBe(200)
    expect(forwardedRoles(relayTarget)).toEqual(['viewer'])
  })

  it('オーバーレイ用キーが違う接続は断る', async () => {
    const { env, relayTarget } = createEnv()

    const response = await connect(env, '/api/overlay/tab?key=違うキー')

    expect(response.status).toBe(401)
    expect(relayTarget.forwardedConnections).toEqual([])
  })

  it('WebSocketでない要求は断る', async () => {
    const { env } = createEnv()

    const response = await invoke(new Request(`${site}/api/overlay/tab?key=${issuedKey}`), env)

    expect(response.status).toBe(400)
  })
})
