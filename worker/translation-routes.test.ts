/**
 * 字幕の翻訳の経路（/api/admin/translation・/api/admin/translation/deepl-usage・/api/admin/translations）のテスト
 *
 * 確かめるのは次の点である。
 * - どの経路も配信者のセッションが無ければ断る
 * - 設定を読み書きでき、DeepL の鍵が設定されているかだけを添える（鍵そのものは返さない）
 * - 確定した1件を設定どおりに訳して返す。「訳さない」なら translation を null で返す
 * - 訳せなかったら 502 で理由を返し、ダッシュボードの失敗の記録にも残す
 * - 本文が想定と違えば 400 で断る
 */
import { describe, expect, it } from 'vitest'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeTokenVault } from './fake-token-vault'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeBucket } from './fake-bucket'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeStore } from './fake-store'
import { createFakeTabChannel } from './fake-tab-channel'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'
import { listFailures } from './stats-store'

const now = Date.parse('2026-10-02T12:00:00Z')
const broadcasterId = '12345'
const site = 'https://hdad.example.com'

/** m2m100 として訳文を返す Workers AI の代役 */
const translatingAi = (translatedText: unknown) => ({ run: () => Promise.resolve({ translated_text: translatedText }) })

const createEnv = (overrides: Partial<Env> = {}) =>
  ({
    STORE: createFakeStore(),
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
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    TOKENS: createFakeTokenVault().namespace,
    AI: createFakeWorkersAi(),
    ...overrides,
  }) satisfies Env

const noFetch = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

const noWait = async (): Promise<void> => {}

const noDefer = (): void => {
  throw new Error('このテストでは、応答のあとに続く処理を使いません')
}

const invoke = (request: Request, env: Env, fetchImpl: typeof fetch = noFetch) =>
  handleRequest(request, env, { fetch: fetchImpl, now: () => now, wait: noWait, waitUntil: noDefer })

/** 配信者としてログイン済みのリクエストを作る。書き換えを伴うメソッドには、ブラウザと同じく Origin を付ける */
const broadcasterRequest = async (env: Env, path: string, init: RequestInit = {}): Promise<Request> => {
  const session = await createSessionToken(broadcasterId, env.SESSION_SECRET, now)
  const headers = new Headers(init.headers)
  headers.set('Cookie', `__Host-session=${session}`)
  if (init.method && init.method !== 'GET') headers.set('Origin', site)
  return new Request(`${site}${path}`, { ...init, headers })
}

const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

const saveProvider = async (env: Env, provider: string) => invoke(await broadcasterRequest(env, '/api/admin/translation', jsonInit('PUT', { provider })), env)

const translate = async (env: Env, body: unknown) => invoke(await broadcasterRequest(env, '/api/admin/translations', jsonInit('POST', body)), env)

describe('翻訳の設定（/api/admin/translation）', () => {
  it('セッションがなければ、取得も保存も401を返す', async () => {
    const env = createEnv()

    expect((await invoke(new Request(`${site}/api/admin/translation`), env)).status).toBe(401)
    expect((await invoke(new Request(`${site}/api/admin/translation`, { method: 'PUT', body: '{}' }), env)).status).toBe(401)
  })

  it('まだ保存していなければ「訳さない」を返し、DeepL の鍵が設定されているかを添える', async () => {
    const env = createEnv()

    expect(await (await invoke(await broadcasterRequest(env, '/api/admin/translation'), env)).json()).toEqual({ provider: 'off', deeplKeyConfigured: false })
  })

  it('保存した設定を読み出せる（DeepL の鍵そのものは返さない）', async () => {
    const env = createEnv({ DEEPL_API_KEY: 'deepl-test-key:fx' })

    expect((await saveProvider(env, 'deepl')).status).toBe(200)

    const body = await (await invoke(await broadcasterRequest(env, '/api/admin/translation'), env)).json()
    expect(body).toEqual({ provider: 'deepl', deeplKeyConfigured: true })
    expect(JSON.stringify(body)).not.toContain('deepl-test-key')
  })

  it('知らない提供元は400で拒む', async () => {
    const response = await saveProvider(createEnv(), 'google')

    expect(response.status).toBe(400)
  })
})

describe('DeepL の使用量（/api/admin/translation/deepl-usage）', () => {
  it('鍵が無ければ、問い合わせずに400で断る', async () => {
    const env = createEnv()

    expect((await invoke(await broadcasterRequest(env, '/api/admin/translation/deepl-usage'), env)).status).toBe(400)
  })

  it('今月訳した文字数と上限を返す', async () => {
    const env = createEnv({ DEEPL_API_KEY: 'deepl-test-key:fx' })
    const fetchImpl = async (): Promise<Response> => Response.json({ character_count: 1200, character_limit: 500000 })

    const response = await invoke(await broadcasterRequest(env, '/api/admin/translation/deepl-usage'), env, fetchImpl)

    expect(await response.json()).toEqual({ characterCount: 1200, characterLimit: 500000 })
  })
})

describe('確定した発話の翻訳（POST /api/admin/translations）', () => {
  it('セッションがなければ401を返す', async () => {
    const env = createEnv()
    const response = await invoke(new Request(`${site}/api/admin/translations`, { method: 'POST', body: '{}' }), env)

    expect(response.status).toBe(401)
  })

  it('「訳さない」なら translation を null で返す', async () => {
    const response = await translate(createEnv(), { text: 'こんばんは', context: [] })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ translation: null })
  })

  it('選んだ提供元で訳した文を返す', async () => {
    const env = createEnv({ AI: translatingAi('Good evening') })
    await saveProvider(env, 'm2m100')

    const response = await translate(env, { text: 'こんばんは', context: ['配信はじめます'] })

    expect(await response.json()).toEqual({ translation: 'Good evening' })
  })

  it('訳せなかったら502で理由を返し、失敗の記録にも残す', async () => {
    const env = createEnv()
    await saveProvider(env, 'deepl')

    const response = await translate(env, { text: 'こんばんは', context: [] })

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: 'translation-failed', message: expect.stringContaining('DEEPL_API_KEY') } })
    expect(await listFailures(env.DB)).toEqual([expect.objectContaining({ code: 'translation-failed' })])
  })

  it.each([
    ['本文が空', { text: '  ', context: [] }],
    ['本文が長すぎる', { text: 'あ'.repeat(1001), context: [] }],
    ['文脈が配列でない', { text: 'こんばんは', context: '配信はじめます' }],
    ['文脈が3件以上', { text: 'こんばんは', context: ['一', '二', '三'] }],
    ['文脈に文字列でないものがある', { text: 'こんばんは', context: [1] }],
  ])('%sなら400で断る', async (_label, body) => {
    expect((await translate(createEnv(), body)).status).toBe(400)
  })
})
