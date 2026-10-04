/**
 * 字幕の経路（/api/admin/caption/socket・/api/overlay/caption）のテスト
 *
 * 字幕は手書きと同じ Durable Object のクラス（worker/draw-channel.ts の DrawChannel）を、別の名前（caption）で使う。
 * 確かめるのは次の4点である。
 * - アプリの枠（配信者のセッション）からの接続が、送る側として字幕の中継先へ引き渡されること
 * - 合成ページ（オーバーレイ用キー）からの接続が、見るだけとして字幕の中継先へ引き渡されること
 * - ログインしていない接続・キーの誤った接続・別のサイトから開かれた接続を断ること
 * - 手書きの接続は今までどおり手書きの中継先へ引き渡されること（字幕と混ざらない）
 */
import { describe, expect, it } from 'vitest'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeTokenVault } from './fake-token-vault'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeBucket } from './fake-bucket'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeTabChannel } from './fake-tab-channel'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeStore } from './fake-store'
import { handleRequest, type Env } from './index'
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
    ASSETS: createFakeAssets(),
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
    TOKENS: createFakeTokenVault().namespace,
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
/** 引き渡された接続の役割（writer・viewer） */
const rolesOf = (connections: readonly Request[]) => connections.map(({ url }) => new URL(url).searchParams.get('role'))

describe('GET /api/admin/caption/socket', () => {
  it('配信者の接続を、送る側として字幕の中継先へ引き渡す', async () => {
    const { env, relayTarget } = createEnv()

    const response = await connectAsBroadcaster(env, '/api/admin/caption/socket')

    expect(response.status).toBe(200)
    expect(rolesOf(relayTarget.forwardedConnections)).toEqual(['writer'])
    expect(relayTarget.forwardedChannels).toEqual(['caption'])
  })

  it('ログインしていない接続は断る', async () => {
    const { env, relayTarget } = createEnv()

    const response = await connect(env, '/api/admin/caption/socket')

    expect(response.status).toBe(401)
    expect(relayTarget.forwardedConnections).toEqual([])
  })

  it('別のサイトから開かれた接続は断る', async () => {
    // WebSocketの接続はGETなので、書き換えのときの送信元の確認（requireAdmin）が効かない。
    // 別サイトに開かせた接続から配信画面へ字幕を出されないよう、Origin を確かめる
    const { env, relayTarget } = createEnv()

    const response = await connectAsBroadcaster(env, '/api/admin/caption/socket', { Origin: 'https://evil.example.com' })

    expect(response.status).toBe(403)
    expect(relayTarget.forwardedConnections).toEqual([])
  })

  it('WebSocketでない要求は断る', async () => {
    const { env } = createEnv()
    const session = await createSessionToken(broadcasterId, env.SESSION_SECRET, now)

    const response = await invoke(new Request(`${site}/api/admin/caption/socket`, { headers: { Cookie: `__Host-session=${session}`, Origin: site } }), env)

    expect(response.status).toBe(400)
  })
})

describe('GET /api/overlay/caption', () => {
  it('オーバーレイ用キーの合う接続を、見るだけとして字幕の中継先へ引き渡す', async () => {
    const { env, relayTarget } = createEnv()

    const response = await connect(env, `/api/overlay/caption?key=${issuedKey}`)

    expect(response.status).toBe(200)
    expect(rolesOf(relayTarget.forwardedConnections)).toEqual(['viewer'])
    expect(relayTarget.forwardedChannels).toEqual(['caption'])
  })

  it('オーバーレイ用キーが違う接続は断る', async () => {
    const { env, relayTarget } = createEnv()

    const response = await connect(env, '/api/overlay/caption?key=違うキー')

    expect(response.status).toBe(401)
    expect(relayTarget.forwardedConnections).toEqual([])
  })

  it('WebSocketでない要求は断る', async () => {
    const { env } = createEnv()

    const response = await invoke(new Request(`${site}/api/overlay/caption?key=${issuedKey}`), env)

    expect(response.status).toBe(400)
  })
})

describe('手書きの経路', () => {
  it('手書きの接続は、字幕ではなく手書きの中継先へ引き渡す', async () => {
    const { env, relayTarget } = createEnv()

    await connectAsBroadcaster(env, '/api/admin/draw/socket')
    await connect(env, `/api/overlay/draw?key=${issuedKey}`)

    expect(relayTarget.forwardedChannels).toEqual(['draw', 'draw'])
  })
})
