/**
 * ワイプの経路（/api/overlay/wipe/icon）のテスト
 *
 * KV・R2・D1を差し替え、handleRequest を通して確かめる。特に重要なのは次の3点。
 * - オーバーレイ用キーがあれば、ログイン名から発言した人のアイコンのURLを Twitch で引いて返すこと
 * - ログイン名の書式が違えば Twitch に問い合わせず400にすること
 * - アイコンを引けなければ、空のURLで済ませず502にすること（Fail-Fast）
 */
import { describe, expect, it } from 'vitest'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeTokenVault } from './fake-token-vault'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeTabChannel } from './fake-tab-channel'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeBucket } from './fake-bucket'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'
import { handleRequest, type Env } from './index'

const now = Date.parse('2026-10-07T12:10:00Z')
const site = 'https://hdad.example.com'
const issuedKey = 'issued-overlay-key-0123456789abcdefghij'

const iconUrl = 'https://static-cdn.jtvnw.net/jtv_user_pictures/kowai_hanashi-profile_image-300x300.png'

const createEnv = (): Env =>
  ({
    STORE: createFakeStore({ 'overlay-key': issuedKey }),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    ASSETS: createFakeAssets(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: '12345',
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: createFakeAlertChannel().namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    TOKENS: createFakeTokenVault().namespace,
    AI: createFakeWorkersAi(),
  }) satisfies Env

/** Twitchへの問い合わせを数えながら答える代役。アプリアクセストークンの発行と、ログイン名からのユーザーの取得にだけ答える */
const createFakeTwitch = () => {
  const calls: string[] = []
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    calls.push(url.pathname)
    if (url.pathname === '/oauth2/token') return Response.json({ access_token: 'test-app-token', expires_in: 5000 })
    if (url.pathname === '/helix/users' && url.searchParams.get('login') === 'kowai_hanashi') {
      return Response.json({ data: [{ id: '100', login: 'kowai_hanashi', profile_image_url: iconUrl }] })
    }
    if (url.pathname === '/helix/users') return Response.json({ data: [] })
    throw new Error(`テストで想定していない通信です: ${String(input)}`)
  }
  return { calls, fetchImpl }
}

const noWait = async (): Promise<void> => {}

/** この経路は応答のあとに続く処理（waitUntil）を使わない */
const noDefer = (): void => {
  throw new Error('このテストでは、応答のあとに続く処理を使いません')
}

const invoke = (path: string, fetchImpl: typeof fetch) =>
  handleRequest(new Request(`${site}${path}`), createEnv(), { fetch: fetchImpl, now: () => now, wait: noWait, waitUntil: noDefer })

describe('GET /api/overlay/wipe/icon', () => {
  it('オーバーレイ用キーがあれば、ログイン名から引いたアイコンのURLを返す', async () => {
    const { fetchImpl } = createFakeTwitch()

    const response = await invoke(`/api/overlay/wipe/icon?key=${issuedKey}&login=kowai_hanashi`, fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ profileImageUrl: iconUrl })
  })

  it('オーバーレイ用キーが違えば401にする', async () => {
    const { fetchImpl } = createFakeTwitch()

    const response = await invoke('/api/overlay/wipe/icon?key=ちがうキー&login=kowai_hanashi', fetchImpl)

    expect(response.status).toBe(401)
  })

  it('ログイン名の書式が違えば、Twitch に問い合わせず400にする', async () => {
    const { calls, fetchImpl } = createFakeTwitch()

    const response = await invoke(`/api/overlay/wipe/icon?key=${issuedKey}&login=${encodeURIComponent('怖い話す人')}`, fetchImpl)

    expect(response.status).toBe(400)
    expect(calls).toEqual([])
  })

  it('ログイン名が無ければ400にする', async () => {
    const { fetchImpl } = createFakeTwitch()

    const response = await invoke(`/api/overlay/wipe/icon?key=${issuedKey}`, fetchImpl)

    expect(response.status).toBe(400)
  })

  it('Twitch にその人が見つからなければ502にする', async () => {
    const { fetchImpl } = createFakeTwitch()

    const response = await invoke(`/api/overlay/wipe/icon?key=${issuedKey}&login=kieta_hito`, fetchImpl)

    expect(response.status).toBe(502)
  })
})
