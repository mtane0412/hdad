/**
 * 手書きの線の経路（/api/admin/draw/socket・/api/overlay/draw）のテスト
 *
 * 確かめるのは次の4点である。
 * - 描く画面（配信者のセッション）からの接続が、描く側として中継先へ引き渡されること
 * - 合成ページ（オーバーレイ用キー）からの接続が、見るだけとして引き渡されること
 * - ログインしていない接続・キーの誤った接続を断ること
 * - 別のサイトから開かれた接続を断ること（WebSocketはGETなので、書き換えのときのCSRF対策が効かない）
 */
import { describe, expect, it } from 'vitest'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeBucket } from './fake-bucket'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeStore } from './fake-store'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'

const 現在時刻 = Date.parse('2026-09-29T09:00:00Z')
const 配信者のID = '12345'
const サイト = 'https://hdad.example.com'
const 発行済みのキー = 'issued-overlay-key-0123456789abcdefghij'

const 環境を作る = () => {
  const 中継先 = createFakeDrawChannel()
  const env = {
    STORE: createFakeStore({ 'overlay-key': 発行済みのキー }),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: 配信者のID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: createFakeAlertChannel().namespace,
    DRAW: 中継先.namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    AI: createFakeWorkersAi(),
  } satisfies Env
  return { env, 中継先 }
}

const Twitchへは通信しない = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

const 待たない = async (): Promise<void> => {}

const 後回しにしない = (): void => {
  throw new Error('このテストでは、応答のあとに続く処理を使いません')
}

const 呼び出す = (request: Request, env: Env) => handleRequest(request, env, { fetch: Twitchへは通信しない, now: () => 現在時刻, wait: 待たない, waitUntil: 後回しにしない })

/** ブラウザがWebSocketをつなぐときと同じヘッダーで呼ぶ */
const つなぐ = (env: Env, path: string, headers: Record<string, string> = {}) =>
  呼び出す(new Request(`${サイト}${path}`, { headers: { Upgrade: 'websocket', Origin: サイト, ...headers } }), env)

/** 配信者としてログインした状態でつなぐ */
const 配信者としてつなぐ = async (env: Env, path: string, headers: Record<string, string> = {}) => {
  const session = await createSessionToken(配信者のID, env.SESSION_SECRET, 現在時刻)
  return つなぐ(env, path, { Cookie: `__Host-session=${session}`, ...headers })
}

describe('GET /api/admin/draw/socket', () => {
  it('配信者の接続を、描く側として中継先へ引き渡す', async () => {
    const { env, 中継先 } = 環境を作る()

    const response = await 配信者としてつなぐ(env, '/api/admin/draw/socket')

    expect(response.status).toBe(200)
    expect(中継先.引き渡された接続.map(({ url }) => new URL(url).searchParams.get('role'))).toEqual(['writer'])
  })

  it('ログインしていない接続は断る', async () => {
    const { env, 中継先 } = 環境を作る()

    const response = await つなぐ(env, '/api/admin/draw/socket')

    expect(response.status).toBe(401)
    expect(中継先.引き渡された接続).toEqual([])
  })

  it('別のサイトから開かれた接続は断る', async () => {
    // WebSocketの接続はGETなので、書き換えのときの送信元の確認（requireAdmin）が効かない。
    // クッキーは SameSite=Lax だが付く場合があるため、ここで確かめる
    const { env, 中継先 } = 環境を作る()

    const response = await 配信者としてつなぐ(env, '/api/admin/draw/socket', { Origin: 'https://evil.example.com' })

    expect(response.status).toBe(403)
    expect(中継先.引き渡された接続).toEqual([])
  })

  it('WebSocketでない要求は断る', async () => {
    const { env } = 環境を作る()
    const session = await createSessionToken(配信者のID, env.SESSION_SECRET, 現在時刻)

    const response = await 呼び出す(new Request(`${サイト}/api/admin/draw/socket`, { headers: { Cookie: `__Host-session=${session}`, Origin: サイト } }), env)

    expect(response.status).toBe(400)
  })
})

describe('GET /api/overlay/draw', () => {
  it('オーバーレイ用キーの合う接続を、見るだけとして中継先へ引き渡す', async () => {
    const { env, 中継先 } = 環境を作る()

    const response = await つなぐ(env, `/api/overlay/draw?key=${発行済みのキー}`)

    expect(response.status).toBe(200)
    expect(中継先.引き渡された接続.map(({ url }) => new URL(url).searchParams.get('role'))).toEqual(['viewer'])
  })

  it('オーバーレイ用キーが違う接続は断る', async () => {
    const { env, 中継先 } = 環境を作る()

    const response = await つなぐ(env, '/api/overlay/draw?key=違うキー')

    expect(response.status).toBe(401)
    expect(中継先.引き渡された接続).toEqual([])
  })

  it('WebSocketでない要求は断る', async () => {
    const { env } = 環境を作る()

    const response = await 呼び出す(new Request(`${サイト}/api/overlay/draw?key=${発行済みのキー}`), env)

    expect(response.status).toBe(400)
  })
})
