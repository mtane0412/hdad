/**
 * テキストの経路（/api/admin/texts・/api/overlay/texts）のテスト
 *
 * handleRequest を通して、次の点を確かめる。
 * - 管理画面（ログイン）から、テキストを読み・追加し・書き換え・消せること。変えるたびに合成ページへ一覧を丸ごと押し出すこと
 * - 検証で拒んだ（名前の重なり・本文の上限）・無いテキストを指した・数の上限を超えた、をそれぞれ見分けて返すこと
 * - 押し出しに失敗したら、保存は済んだことを添えて502にすること（黙って成功にしない）
 * - 合成ページ（オーバーレイ用キー）から、テキストの一覧を読めること
 *
 * 検証の中身は worker/text.test.ts、読み書きの中身は worker/text-store.test.ts が確かめるので、ここでは経路の受け渡しだけを見る。
 */
import { describe, expect, it } from 'vitest'
import type { AdBreakTimerNamespace } from './ad-break-timer'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeBucket } from './fake-bucket'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeStore } from './fake-store'
import { createFakeTabChannel } from './fake-tab-channel'
import { createFakeTokenVault } from './fake-token-vault'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'
import { MAX_TEXT_BODY_LENGTH, MAX_TEXT_COUNT, type TextEntry } from './text'
import { insertText, readTexts } from './text-store'

const NOW = Date.parse('2026-10-08T12:00:00.000Z')
const BROADCASTER_ID = '12345'
const SITE = 'https://hdad.example.com'
const ISSUED_KEY = 'issued-overlay-key-0123456789abcdefghij'

/** テキストを追加し、追加したものを返す（上限に達して追加できなければテストを失敗させる） */
const addText = async (...args: Parameters<typeof insertText>): Promise<TextEntry> => {
  const text = await insertText(...args)
  if (text === null) throw new Error('テキストを追加できませんでした（持てる数に達しています）')
  return text
}

const noTwitchFetch = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

/**
 * テキストを1件も持たない環境。
 *
 * @param failPush 配送先が失敗を返すようにする（押し出しの失敗を確かめるとき）
 */
const setupEnv = (failPush = false) => {
  const channel = createFakeAlertChannel({ shouldFail: failPush })
  const env = {
    STORE: createFakeStore({ 'overlay-key': ISSUED_KEY }),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    ASSETS: createFakeAssets(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: BROADCASTER_ID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: channel.namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    // テキストの経路はタイマーを使わない
    AD_BREAKS: undefined as unknown as AdBreakTimerNamespace,
    TOKENS: createFakeTokenVault().namespace,
    AI: createFakeWorkersAi(),
  } satisfies Env
  return { env, channel }
}

const callHandler = (request: Request, env: Env) =>
  handleRequest(request, env, {
    fetch: noTwitchFetch,
    now: () => NOW,
    wait: async () => {},
    waitUntil: () => {
      throw new Error('このテストでは、応答のあとに続く処理を使いません')
    },
  })

/** 配信者としてログインした状態で呼ぶ。書き換えのときは Origin も付ける（ブラウザが付けるのと同じ） */
const callAsBroadcaster = async (env: Env, path: string, init: RequestInit = {}): Promise<Response> => {
  const session = await createSessionToken(BROADCASTER_ID, env.SESSION_SECRET, NOW)
  const headers: Record<string, string> = { Cookie: `__Host-session=${session}`, 'Content-Type': 'application/json' }
  if (init.method !== undefined && init.method !== 'GET') headers.Origin = SITE
  return callHandler(new Request(`${SITE}${path}`, { ...init, headers }), env)
}

/** 手で書くテキストの、指示文を持たない入力 */
const manual = (name: string, body: string) => ({ name, mode: 'manual', body, instruction: '' }) as const

const postText = (env: Env, body: unknown) => callAsBroadcaster(env, '/api/admin/texts', { method: 'POST', body: JSON.stringify(body) })
const putText = (env: Env, id: number | string, body: unknown) => callAsBroadcaster(env, `/api/admin/texts/${id}`, { method: 'PUT', body: JSON.stringify(body) })
const removeText = (env: Env, id: number | string) => callAsBroadcaster(env, `/api/admin/texts/${id}`, { method: 'DELETE' })

describe('GET /api/admin/texts', () => {
  it('テキストを追加した順に返す', async () => {
    const { env } = setupEnv()
    const goal = await addText(env.DB, manual('目標', 'ログイン画面を作り終える'), NOW)

    const response = await callAsBroadcaster(env, '/api/admin/texts')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ texts: [goal] })
  })

  it('ログインしていなければ401にする', async () => {
    const { env } = setupEnv()

    expect((await callHandler(new Request(`${SITE}/api/admin/texts`), env)).status).toBe(401)
  })
})

describe('POST /api/admin/texts', () => {
  it('テキストを追加し、合成ページへ一覧を押し出す', async () => {
    const { env, channel } = setupEnv()

    const response = await postText(env, manual('目標', 'ログイン画面を作り終える'))

    expect(response.status).toBe(201)
    const texts = await readTexts(env.DB)
    expect(await response.json()).toEqual({ text: texts[0] })
    expect(channel.pushedTexts).toEqual([{ texts }])
  })

  it('ほかのテキストと同じ名前は、問題点を添えて400にする', async () => {
    const { env, channel } = setupEnv()
    await insertText(env.DB, manual('目標', ''), NOW)

    const response = await postText(env, manual('目標', '別の目標'))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { problems: ['name: 「目標」という名前のテキストはもうあります'] } })
    expect(channel.pushedTexts).toEqual([])
  })

  it('持てる数を超えたら409にする', async () => {
    const { env } = setupEnv()
    for (let index = 0; index < MAX_TEXT_COUNT; index += 1) await insertText(env.DB, manual(`メモ${index + 1}`, ''), NOW)

    const response = await postText(env, manual('目標', ''))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'too-many-texts' } })
  })

  it('押し出しに失敗したら、追加は済んだことを添えて502にする', async () => {
    const { env } = setupEnv(true)

    const response = await postText(env, manual('目標', 'ログイン画面を作り終える'))

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: 'text-push-failed', message: expect.stringContaining('保存しました') } })
    expect(await readTexts(env.DB)).toHaveLength(1)
  })
})

describe('PUT /api/admin/texts/:id', () => {
  it('名前と本文を書き換え、合成ページへ一覧を押し出す', async () => {
    const { env, channel } = setupEnv()
    const goal = await addText(env.DB, manual('目標', 'ログイン画面を作り終える'), NOW)

    const response = await putText(env, goal.id, manual('目標', 'ログイン画面をデプロイする'))

    expect(response.status).toBe(200)
    const updated = { ...goal, body: 'ログイン画面をデプロイする' }
    expect(await response.json()).toEqual({ text: updated })
    expect(channel.pushedTexts).toEqual([{ texts: [updated] }])
  })

  it('自分自身の名前のままなら、名前の重なりとして拒まない', async () => {
    const { env } = setupEnv()
    const goal = await addText(env.DB, manual('目標', ''), NOW)
    await insertText(env.DB, manual('今やってること', ''), NOW)

    expect((await putText(env, goal.id, manual('目標', '書き換えた'))).status).toBe(200)
    expect((await putText(env, goal.id, manual('今やってること', ''))).status).toBe(400)
  })

  it('自動へ切り替えた保存では、送られてきた本文で書き換えない（本文は LLM が書くため）', async () => {
    const { env } = setupEnv()
    const doing = await addText(env.DB, manual('今やってること', 'テストを書いている'), NOW)

    const response = await putText(env, doing.id, { name: '今やってること', mode: 'auto', body: '画面が古いまま送った本文', instruction: 'いまやっている作業を20字で' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ text: { ...doing, mode: 'auto', instruction: 'いまやっている作業を20字で' } })
  })

  it('本文が上限を超えたら400にする', async () => {
    const { env } = setupEnv()
    const goal = await addText(env.DB, manual('目標', ''), NOW)

    const response = await putText(env, goal.id, manual('目標', 'あ'.repeat(MAX_TEXT_BODY_LENGTH + 1)))

    expect(response.status).toBe(400)
  })

  it('無いテキスト・IDとして読めない値は404にする', async () => {
    const { env } = setupEnv()

    expect((await putText(env, 999, manual('目標', ''))).status).toBe(404)
    expect((await putText(env, 'goal', manual('目標', ''))).status).toBe(404)
  })
})

describe('DELETE /api/admin/texts/:id', () => {
  it('テキストを消し、合成ページへ一覧を押し出す', async () => {
    const { env, channel } = setupEnv()
    const goal = await addText(env.DB, manual('目標', ''), NOW)

    const response = await removeText(env, goal.id)

    expect(response.status).toBe(204)
    expect(await readTexts(env.DB)).toEqual([])
    expect(channel.pushedTexts).toEqual([{ texts: [] }])
  })

  it('無いテキストは404にする', async () => {
    const { env } = setupEnv()

    expect((await removeText(env, 999)).status).toBe(404)
  })
})

describe('GET /api/overlay/texts', () => {
  it('オーバーレイ用キーで、テキストの一覧を読める', async () => {
    const { env } = setupEnv()
    const goal = await addText(env.DB, manual('目標', 'ログイン画面を作り終える'), NOW)

    const response = await callHandler(new Request(`${SITE}/api/overlay/texts?key=${ISSUED_KEY}`), env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ texts: [goal] })
  })

  it('キーが違えば受け付けない', async () => {
    const { env } = setupEnv()

    expect((await callHandler(new Request(`${SITE}/api/overlay/texts?key=wrong-key`), env)).status).toBe(401)
  })
})

describe('GET /api/overlay/texts/socket', () => {
  it('WebSocketの接続でなければ400にする', async () => {
    const { env } = setupEnv()

    expect((await callHandler(new Request(`${SITE}/api/overlay/texts/socket?key=${ISSUED_KEY}`), env)).status).toBe(400)
  })

  it('オーバーレイ用キーを確かめて、配送先へ引き渡す', async () => {
    const { env, channel } = setupEnv()

    const response = await callHandler(new Request(`${SITE}/api/overlay/texts/socket?key=${ISSUED_KEY}`, { headers: { Upgrade: 'websocket' } }), env)

    expect(response.status).toBe(200)
    expect(channel.forwardedConnections).toHaveLength(1)
    expect(new URL(channel.forwardedConnections[0]?.url ?? '').searchParams.get('topic')).toBe('text')
  })
})
