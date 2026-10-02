/**
 * 注目コメントの経路（/api/admin/focus・/api/overlay/focus）のテスト
 *
 * KV・R2・D1を差し替え、handleRequest を通して確かめる。特に重要なのは次の4点。
 * - 管理画面（セッション）とオーバーレイ（オーバーレイ用キー）の両方から、同じ内容が読めること
 * - 取り上げたときに、発言した人のアイコンをTwitchから引いて添えること
 * - 検証で見つかった問題点が、400の応答に並んで返ること（画面で一度に直せるようにするため）
 * - 書き換え（PUT）に送信元の確認（CSRF対策）が効くこと
 */
import { describe, expect, it } from 'vitest'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeTabChannel } from './fake-tab-channel'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeBucket } from './fake-bucket'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'
import { loadFocusTarget, type FocusTarget } from './focus-config'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'

const now = Date.parse('2026-09-27T12:10:00Z')
const streamerId = '12345'
const site = 'https://hdad.example.com'
const issuedKey = 'issued-overlay-key-0123456789abcdefghij'

/** 雑談の題に取り上げる発言1件（管理画面が送る形） */
const chatToFocus = {
  messageId: 'chat-message-1',
  login: 'kowai_hanashi',
  displayName: '怖い話す人',
  text: '今から怖い話をするね',
}

const iconUrl = 'https://static-cdn.jtvnw.net/jtv_user_pictures/kowai_hanashi-profile_image-300x300.png'

/** 保存される中身（アイコンのURLが添えられる） */
const storedContent: FocusTarget = { ...chatToFocus, profileImageUrl: iconUrl }

const createEnv = () => {
  const env = {
    STORE: createFakeStore({ 'overlay-key': issuedKey }),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    ASSETS: createFakeAssets(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: streamerId,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: createFakeAlertChannel().namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    AI: createFakeWorkersAi(),
  } satisfies Env
  return { env }
}

/** Twitchの代役。アプリアクセストークンの発行と、ログイン名からのユーザーの取得にだけ答える */
const fakeTwitch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.pathname === '/oauth2/token') return Response.json({ access_token: 'test-app-token', expires_in: 5000 })
  if (url.pathname === '/helix/users' && url.searchParams.get('login') === 'kowai_hanashi') {
    return Response.json({ data: [{ id: '100', login: 'kowai_hanashi', profile_image_url: iconUrl }] })
  }
  if (url.pathname === '/helix/users') return Response.json({ data: [] })
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

const noWait = async (): Promise<void> => {}

/** これらの経路は応答のあとに続く処理（waitUntil）を使わない */
const noDefer = (): void => {
  throw new Error('このテストでは、応答のあとに続く処理を使いません')
}

const invoke = (request: Request, env: Env) => handleRequest(request, env, { fetch: fakeTwitch, now: () => now, wait: noWait, waitUntil: noDefer })

/** 配信者としてログインした状態で呼ぶ。書き換えのときは Origin も付ける（ブラウザが付けるのと同じ） */
const invokeAsStreamer = async (env: Env, path: string, init: RequestInit = {}): Promise<Response> => {
  const session = await createSessionToken(streamerId, env.SESSION_SECRET, now)
  const headers: Record<string, string> = { Cookie: `__Host-session=${session}` }
  if (init.method !== undefined && init.method !== 'GET') headers.Origin = site
  return invoke(new Request(`${site}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } }), env)
}

/** 取り上げているものを保存する（管理画面が送るのと同じ形） */
const save = (env: Env, target: unknown) =>
  invokeAsStreamer(env, '/api/admin/focus', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target }),
  })

describe('GET /api/admin/focus', () => {
  it('一度も保存していなければ、取り上げていない状態を返す', async () => {
    const { env } = createEnv()

    const response = await invokeAsStreamer(env, '/api/admin/focus')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ target: null })
  })

  it('保存した中身を返す', async () => {
    const { env } = createEnv()
    await save(env, chatToFocus)

    const response = await invokeAsStreamer(env, '/api/admin/focus')

    expect(await response.json()).toEqual({ target: storedContent })
  })

  it('ログインしていなければ401にする', async () => {
    const { env } = createEnv()

    const response = await invoke(new Request(`${site}/api/admin/focus`), env)

    expect(response.status).toBe(401)
  })
})

describe('PUT /api/admin/focus', () => {
  it('取り上げた発言に、発言した人のアイコンを添えて保存する', async () => {
    const { env } = createEnv()

    const response = await save(env, chatToFocus)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ target: storedContent })
    expect(await loadFocusTarget(env.STORE)).toEqual(storedContent)
  })

  it('発言した人がTwitchに見つからなければ、保存せずに失敗にする（アイコンの無い箱を映さないため）', async () => {
    const { env } = createEnv()

    const response = await save(env, { ...chatToFocus, login: 'kieta_hito' })

    expect(response.status).toBe(502)
    expect(await loadFocusTarget(env.STORE)).toBeNull()
  })

  it('取り上げているものを外せる（配信中に元へ戻す操作があるため）', async () => {
    const { env } = createEnv()
    await save(env, chatToFocus)

    const response = await save(env, null)

    expect(await response.json()).toEqual({ target: null })
    expect(await loadFocusTarget(env.STORE)).toBeNull()
  })

  it('問題があれば400にして、問題点を並べて返す', async () => {
    const { env } = createEnv()

    const response = await save(env, { ...chatToFocus, login: '怖い話す人' })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { problems: string[] } }
    expect(body.error.problems).toEqual([expect.stringContaining('login')])
  })

  it('本文がJSONでなければ400にする', async () => {
    const { env } = createEnv()

    const response = await invokeAsStreamer(env, '/api/admin/focus', { method: 'PUT', body: 'これはJSONではありません' })

    expect(response.status).toBe(400)
  })

  it('送信元が違えば拒む（CSRF対策）', async () => {
    const { env } = createEnv()
    const session = await createSessionToken(streamerId, env.SESSION_SECRET, now)

    const response = await invoke(
      new Request(`${site}/api/admin/focus`, {
        method: 'PUT',
        headers: { Cookie: `__Host-session=${session}`, Origin: 'https://evil.example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: null }),
      }),
      env,
    )

    expect(response.status).toBe(403)
  })
})

describe('GET /api/overlay/focus', () => {
  it('オーバーレイ用キーがあれば、取り上げているものを返す', async () => {
    const { env } = createEnv()
    await save(env, chatToFocus)

    const response = await invoke(new Request(`${site}/api/overlay/focus?key=${issuedKey}`), env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ target: storedContent })
  })

  it('オーバーレイ用キーが違えば401にする', async () => {
    const { env } = createEnv()

    const response = await invoke(new Request(`${site}/api/overlay/focus?key=ちがうキー`), env)

    expect(response.status).toBe(401)
  })
})
