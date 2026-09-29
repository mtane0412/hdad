/**
 * 注目コメントの経路（/api/admin/focus・/api/overlay/focus）のテスト
 *
 * KV・R2・D1を差し替え、handleRequest を通して確かめる。特に重要なのは次の4点。
 * - 管理画面（セッション）とオーバーレイ（オーバーレイ用キー）の両方から、同じ内容が読めること
 * - 検証で見つかった問題点が、400の応答に並んで返ること（画面で一度に直せるようにするため）
 * - 取り上げる発言を選ぶ一覧が、いま進んでいる配信の直近の発言を新しい順で返すこと
 * - 書き換え（PUT）に送信元の確認（CSRF対策）が効くこと
 */
import { describe, expect, it } from 'vitest'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeBucket } from './fake-bucket'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'
import { loadFocusTarget, type FocusTarget } from './focus-config'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'
import { recordStreamOnline } from './stats-store'
import { recordStreamChatMessage } from './stream-chat-store'
import { recordViewerMessage } from './viewer-store'

const 現在時刻 = Date.parse('2026-09-27T12:10:00Z')
const 配信者のID = '12345'
const サイト = 'https://hdad.example.com'
const 発行済みのキー = 'issued-overlay-key-0123456789abcdefghij'

/** 怖い話を始めた視聴者に追従する指定 */
const 追従の指定: FocusTarget = { type: 'viewer', login: 'kowai_hanashi' }

const 環境を作る = () => {
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
    DRAW: createFakeDrawChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    AI: createFakeWorkersAi(),
  } satisfies Env
  return { env }
}

const Twitchへは通信しない = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

const 待たない = async (): Promise<void> => {}

/** これらの経路は応答のあとに続く処理（waitUntil）を使わない */
const 後回しにしない = (): void => {
  throw new Error('このテストでは、応答のあとに続く処理を使いません')
}

const 呼び出す = (request: Request, env: Env) => handleRequest(request, env, { fetch: Twitchへは通信しない, now: () => 現在時刻, wait: 待たない, waitUntil: 後回しにしない })

/** 配信者としてログインした状態で呼ぶ。書き換えのときは Origin も付ける（ブラウザが付けるのと同じ） */
const 配信者として呼ぶ = async (env: Env, path: string, init: RequestInit = {}): Promise<Response> => {
  const session = await createSessionToken(配信者のID, env.SESSION_SECRET, 現在時刻)
  const headers: Record<string, string> = { Cookie: `__Host-session=${session}` }
  if (init.method !== undefined && init.method !== 'GET') headers.Origin = サイト
  return 呼び出す(new Request(`${サイト}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } }), env)
}

/** 取り上げているものを保存する（管理画面が送るのと同じ形） */
const 保存する = (env: Env, target: unknown) =>
  配信者として呼ぶ(env, '/api/admin/focus', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target }),
  })

describe('GET /api/admin/focus', () => {
  it('一度も保存していなければ、取り上げていない状態を返す', async () => {
    const { env } = 環境を作る()

    const response = await 配信者として呼ぶ(env, '/api/admin/focus')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ target: null })
  })

  it('保存した指定を返す', async () => {
    const { env } = 環境を作る()
    await 保存する(env, 追従の指定)

    const response = await 配信者として呼ぶ(env, '/api/admin/focus')

    expect(await response.json()).toEqual({ target: 追従の指定 })
  })

  it('ログインしていなければ401にする', async () => {
    const { env } = 環境を作る()

    const response = await 呼び出す(new Request(`${サイト}/api/admin/focus`), env)

    expect(response.status).toBe(401)
  })
})

describe('PUT /api/admin/focus', () => {
  it('人に追従する指定を保存する', async () => {
    const { env } = 環境を作る()

    const response = await 保存する(env, 追従の指定)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ target: 追従の指定 })
    expect(await loadFocusTarget(env.STORE)).toEqual(追従の指定)
  })

  it('発言1件を取り上げる指定を保存する', async () => {
    const { env } = 環境を作る()
    const 取り上げの指定 = {
      type: 'message',
      messageId: 'chat-message-1',
      login: 'kowai_hanashi',
      displayName: '怖い話す人',
      text: '今から怖い話をするね',
    }

    const response = await 保存する(env, 取り上げの指定)

    expect(await response.json()).toEqual({ target: 取り上げの指定 })
  })

  it('取り上げているものを外せる（配信中に元へ戻す操作があるため）', async () => {
    const { env } = 環境を作る()
    await 保存する(env, 追従の指定)

    const response = await 保存する(env, null)

    expect(await response.json()).toEqual({ target: null })
    expect(await loadFocusTarget(env.STORE)).toBeNull()
  })

  it('問題があれば400にして、問題点を並べて返す', async () => {
    const { env } = 環境を作る()

    const response = await 保存する(env, { type: 'viewer', login: '怖い話す人' })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { problems: string[] } }
    expect(body.error.problems).toEqual([expect.stringContaining('login')])
  })

  it('本文がJSONでなければ400にする', async () => {
    const { env } = 環境を作る()

    const response = await 配信者として呼ぶ(env, '/api/admin/focus', { method: 'PUT', body: 'これはJSONではありません' })

    expect(response.status).toBe(400)
  })

  it('送信元が違えば拒む（CSRF対策）', async () => {
    const { env } = 環境を作る()
    const session = await createSessionToken(配信者のID, env.SESSION_SECRET, 現在時刻)

    const response = await 呼び出す(
      new Request(`${サイト}/api/admin/focus`, {
        method: 'PUT',
        headers: { Cookie: `__Host-session=${session}`, Origin: 'https://evil.example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: null }),
      }),
      env,
    )

    expect(response.status).toBe(403)
  })
})

describe('GET /api/admin/focus/messages', () => {
  /** 配信中の発言を1件記録する（発言者の記録も作る。取り上げるには名前が要る） */
  const 発言を記録する = async (env: Env, messageId: string, text: string, at: number) => {
    await recordViewerMessage(env.DB, { userId: '100', login: 'kowai_hanashi', displayName: '怖い話す人', badges: [], messageId: 'viewer-100' }, at)
    await recordStreamChatMessage(env.DB, { messageId, userId: '100', text }, at)
  }

  it('いま進んでいる配信の直近の発言を、新しい順に名前付きで返す', async () => {
    const { env } = 環境を作る()
    await recordStreamOnline(env.DB, { id: 'stream-1', startedAt: 現在時刻 - 60 * 60 * 1000 })
    await 発言を記録する(env, '発言1', 'こんばんは！', 現在時刻 - 60 * 1000)
    await 発言を記録する(env, '発言2', '今から怖い話をするね', 現在時刻)

    const response = await 配信者として呼ぶ(env, '/api/admin/focus/messages')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      messages: [
        { messageId: '発言2', login: 'kowai_hanashi', displayName: '怖い話す人', text: '今から怖い話をするね', at: '2026-09-27T12:10:00.000Z' },
        { messageId: '発言1', login: 'kowai_hanashi', displayName: '怖い話す人', text: 'こんばんは！', at: '2026-09-27T12:09:00.000Z' },
      ],
    })
  })

  it('配信していなければ空の一覧を返す（配信中のあいだだけ本文を貯めているため）', async () => {
    const { env } = 環境を作る()

    const response = await 配信者として呼ぶ(env, '/api/admin/focus/messages')

    expect(await response.json()).toEqual({ messages: [] })
  })

  it('ログインしていなければ401にする', async () => {
    const { env } = 環境を作る()

    const response = await 呼び出す(new Request(`${サイト}/api/admin/focus/messages`), env)

    expect(response.status).toBe(401)
  })
})

describe('GET /api/overlay/focus', () => {
  it('オーバーレイ用キーがあれば、取り上げているものを返す', async () => {
    const { env } = 環境を作る()
    await 保存する(env, 追従の指定)

    const response = await 呼び出す(new Request(`${サイト}/api/overlay/focus?key=${発行済みのキー}`), env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ target: 追従の指定 })
  })

  it('オーバーレイ用キーが違えば401にする', async () => {
    const { env } = 環境を作る()

    const response = await 呼び出す(new Request(`${サイト}/api/overlay/focus?key=ちがうキー`), env)

    expect(response.status).toBe(401)
  })
})
