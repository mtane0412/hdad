/**
 * タブの映像の連絡の経路（/api/admin/tab/socket・/api/overlay/tab）のテスト
 *
 * 確かめるのは次の6点である。
 * - 送り手（拡張の offscreen document が配信者のセッションでつなぐ）からの接続が、送り手として中継先へ引き渡されること
 * - 合成ページ（オーバーレイ用キー）からの接続が、合成ページとして引き渡されること
 * - ログインしていない接続・キーの誤った接続を断ること
 * - HDAD の拡張以外から開かれた接続を断ること（WebSocketはGETなので、書き換えのときのCSRF対策が効かない）
 * - 拡張が WebSocket のプロトコルの欄で渡したセッションを確かめること（拡張からの WebSocket にはクッキーが付かないため）
 * - 拡張が読むクッキーの名前が、Worker が発行する名前と一致すること
 * - 映さないサイトの一覧を、拡張（Authorization ヘッダーのセッション）と /tab/（クッキー）から読み書きできること
 */
import { describe, expect, it } from 'vitest'
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
import { EXTENSION_ID } from '../extension/src/identity'
import { SESSION_COOKIE_NAME } from '../extension/src/session-cookie'
import { BLOCKED_HOSTS_PATH } from '../src/tab/blocked-hosts'
import { SENDER_PROTOCOL } from '../src/tab/signal'
import { SESSION_COOKIE } from './http'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'

const now = Date.parse('2026-10-01T10:00:00Z')
const broadcasterId = '12345'
const site = 'https://hdad.example.com'
const issuedKey = 'issued-overlay-key-0123456789abcdefghij'
/** HDAD の拡張（manifest.json の key で固定したID）の Origin */
const extensionOrigin = `chrome-extension://${EXTENSION_ID}`

const createEnv = () => {
  const relayTarget = createFakeTabChannel()
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

/** 配信者としてログインした拡張からつなぐ（拡張は置き場所への権限を持つので、配信者のクッキーが付く） */
const connectAsBroadcaster = async (env: Env, path: string, headers: Record<string, string> = {}) => {
  const session = await createSessionToken(broadcasterId, env.SESSION_SECRET, now)
  return connect(env, path, { Cookie: `__Host-session=${session}`, Origin: extensionOrigin, ...headers })
}

/** 中継先へ引き渡された接続の役割 */
const forwardedRoles = (relayTarget: ReturnType<typeof createFakeTabChannel>) =>
  relayTarget.forwardedConnections.map(({ url }) => new URL(url).searchParams.get('role'))

describe('GET /api/admin/tab/socket', () => {
  it('拡張からの配信者の接続を、送り手として中継先へ引き渡す', async () => {
    const { env, relayTarget } = createEnv()

    const response = await connectAsBroadcaster(env, '/api/admin/tab/socket')

    expect(response.status).toBe(200)
    expect(forwardedRoles(relayTarget)).toEqual(['sender'])
  })

  it('拡張がプロトコルの欄で渡したセッションを確かめて、送り手として引き渡し、プロトコルを応える', async () => {
    // 拡張の offscreen document からの WebSocket にはクッキーが付かないので、拡張は chrome.cookies で読んだ値をここで渡す
    const { env, relayTarget } = createEnv()
    const session = await createSessionToken(broadcasterId, env.SESSION_SECRET, now)

    const response = await connect(env, '/api/admin/tab/socket', { Origin: extensionOrigin, 'Sec-WebSocket-Protocol': `${SENDER_PROTOCOL}, ${session}` })

    expect(response.status).toBe(200)
    expect(response.headers.get('Sec-WebSocket-Protocol')).toBe(SENDER_PROTOCOL)
    expect(forwardedRoles(relayTarget)).toEqual(['sender'])
  })

  it('プロトコルの欄のセッションが正しくなければ断る', async () => {
    const { env, relayTarget } = createEnv()

    const response = await connect(env, '/api/admin/tab/socket', { Origin: extensionOrigin, 'Sec-WebSocket-Protocol': `${SENDER_PROTOCOL}, 12345.9999999999.forged-signature` })

    expect(response.status).toBe(401)
    expect(relayTarget.forwardedConnections).toEqual([])
  })

  it('プロトコルの欄のセッションが正しくても、HDAD の拡張以外からの接続は断る', async () => {
    const { env, relayTarget } = createEnv()
    const session = await createSessionToken(broadcasterId, env.SESSION_SECRET, now)

    const response = await connect(env, '/api/admin/tab/socket', { Origin: 'https://evil.example.com', 'Sec-WebSocket-Protocol': `${SENDER_PROTOCOL}, ${session}` })

    expect(response.status).toBe(403)
    expect(relayTarget.forwardedConnections).toEqual([])
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

  it('ほかの拡張から開かれた接続は断る', async () => {
    const { env, relayTarget } = createEnv()

    const response = await connectAsBroadcaster(env, '/api/admin/tab/socket', { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' })

    expect(response.status).toBe(403)
    expect(relayTarget.forwardedConnections).toEqual([])
  })

  it('WebSocketでない要求は断る', async () => {
    const { env } = createEnv()
    const session = await createSessionToken(broadcasterId, env.SESSION_SECRET, now)

    const response = await invoke(new Request(`${site}/api/admin/tab/socket`, { headers: { Cookie: `__Host-session=${session}`, Origin: extensionOrigin } }), env)

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

describe('映さないサイトの一覧（/api/admin/tab/blocked-hosts）', () => {
  /** 拡張のサービスワーカーと同じく、chrome.cookies で読んだセッションを Authorization ヘッダーで渡して呼ぶ */
  const callAsExtension = async (env: Env, init: RequestInit = {}, session?: string, path = BLOCKED_HOSTS_PATH) => {
    const token = session ?? (await createSessionToken(broadcasterId, env.SESSION_SECRET, now))
    return invoke(
      new Request(`${site}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }),
      env,
    )
  }

  /** /tab/ のページと同じく、クッキーを付けて同じサイトから呼ぶ */
  const callAsPage = async (env: Env, path: string, init: RequestInit = {}) => {
    const session = await createSessionToken(broadcasterId, env.SESSION_SECRET, now)
    return invoke(new Request(`${site}${path}`, { ...init, headers: { Cookie: `__Host-session=${session}`, Origin: site } }), env)
  }

  it('拡張がボタンの右クリックで登録したホスト名を、拡張と /tab/ の両方から読める', async () => {
    const { env } = createEnv()

    const added = await callAsExtension(env, { method: 'POST', body: JSON.stringify({ host: 'mail.google.com' }) })
    expect(added.status).toBe(200)
    expect(await added.json()).toEqual({ hosts: ['mail.google.com'] })

    expect(await (await callAsExtension(env)).json()).toEqual({ hosts: ['mail.google.com'] })
    expect(await (await callAsPage(env, BLOCKED_HOSTS_PATH)).json()).toEqual({ hosts: ['mail.google.com'] })
  })

  it('ホスト名でないものは登録せずに 400 を返す', async () => {
    const { env } = createEnv()

    const response = await callAsExtension(env, { method: 'POST', body: JSON.stringify({ host: 'https://mail.google.com/mail' }) })

    expect(response.status).toBe(400)
    expect(await (await callAsExtension(env)).json()).toEqual({ hosts: [] })
  })

  it('/tab/ から消したホスト名は一覧から外れる', async () => {
    const { env } = createEnv()
    await callAsExtension(env, { method: 'POST', body: JSON.stringify({ host: 'mail.google.com' }) })

    const response = await callAsPage(env, `${BLOCKED_HOSTS_PATH}/mail.google.com`, { method: 'DELETE' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ hosts: [] })
  })

  it('拡張の設定ページから消したホスト名は一覧から外れる', async () => {
    const { env } = createEnv()
    await callAsExtension(env, { method: 'POST', body: JSON.stringify({ host: 'mail.google.com' }) })

    const response = await callAsExtension(env, { method: 'DELETE' }, undefined, `${BLOCKED_HOSTS_PATH}/mail.google.com`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ hosts: [] })
  })

  it('Authorization ヘッダーのセッションが正しくなければ断る', async () => {
    const { env } = createEnv()

    const response = await callAsExtension(env, {}, '12345.9999999999.forged-signature')

    expect(response.status).toBe(401)
  })

  it('ログインしていなければ断る', async () => {
    const { env } = createEnv()

    const response = await invoke(new Request(`${site}${BLOCKED_HOSTS_PATH}`), env)

    expect(response.status).toBe(401)
  })

  it('クッキーで呼ぶなら、別のサイトからの書き換えは断る（CSRF対策）', async () => {
    const { env } = createEnv()
    const session = await createSessionToken(broadcasterId, env.SESSION_SECRET, now)

    const response = await invoke(
      new Request(`${site}${BLOCKED_HOSTS_PATH}`, {
        method: 'POST',
        body: JSON.stringify({ host: 'mail.google.com' }),
        headers: { Cookie: `__Host-session=${session}`, Origin: 'https://evil.example.com' },
      }),
      env,
    )

    expect(response.status).toBe(403)
  })
})

describe('拡張が読むセッションのクッキーの名前', () => {
  it('Worker が発行するセッションのクッキーの名前と一致する', () => {
    // 食い違うと、拡張は「ログインしていない」と誤って知らせ続ける（extension/src/session-cookie.ts）
    expect(SESSION_COOKIE_NAME).toBe(SESSION_COOKIE)
  })
})
