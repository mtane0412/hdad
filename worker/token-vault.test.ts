/**
 * トークンの保管庫（token-vault.ts）のテスト
 *
 * Twitchのトークンは Durable Object（TokenVault）の保管（storage）に持つ。読む・書く・消すに加えて、
 * 「保存済みのトークンが期待どおりのときだけ置き換える」を1回の要求で受け付け、読み直しと書き込みの間に
 * 切断・付け替えが割り込めないようにする（issue #220）。
 * 以前はKV（STORE）に保存していたので、初めて起きたときに1度だけKVから移し、KVからは消す。
 */
import { describe, expect, it } from 'vitest'
import { createFakeStore } from './fake-store'
import { createFakeTokenStorage } from './fake-token-vault'
import { handleTokenVaultRequest, migrateLegacyTokens } from './token-vault'
import type { StoredToken } from './token'

const now = Date.UTC(2026, 9, 4, 12, 0, 0)

const botToken = (overrides: Partial<StoredToken> = {}): StoredToken => ({
  accessToken: '旧botのアクセストークン',
  refreshToken: '旧botのリフレッシュトークン',
  expiresAt: now,
  scopes: ['user:write:chat'],
  userId: '67890',
  login: 'furui_bot',
  ...overrides,
})

const request = (method: string, path: string, body?: unknown): Request =>
  new Request(`https://token-vault${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

describe('handleTokenVaultRequest', () => {
  it('保存したトークンを、役割ごとに読み出せる', async () => {
    const storage = createFakeTokenStorage()

    await handleTokenVaultRequest(storage, request('PUT', '/token?role=bot', botToken()))
    const response = await handleTokenVaultRequest(storage, request('GET', '/token?role=bot'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(botToken())
    expect((await handleTokenVaultRequest(storage, request('GET', '/token?role=broadcaster'))).status).toBe(404)
  })

  it('消したトークンは読めなくなる', async () => {
    const storage = createFakeTokenStorage()
    await handleTokenVaultRequest(storage, request('PUT', '/token?role=bot', botToken()))

    await handleTokenVaultRequest(storage, request('DELETE', '/token?role=bot'))

    expect((await handleTokenVaultRequest(storage, request('GET', '/token?role=bot'))).status).toBe(404)
  })

  it('保存（PUT）と削除（DELETE）は、それまで保存していたトークンを返す（外したトークンをTwitchで失効させるため。issue #221）', async () => {
    const storage = createFakeTokenStorage()
    const replacement = botToken({ accessToken: '新botのアクセストークン', refreshToken: '新botのリフレッシュトークン' })

    const first = await handleTokenVaultRequest(storage, request('PUT', '/token?role=bot', botToken()))
    const second = await handleTokenVaultRequest(storage, request('PUT', '/token?role=bot', replacement))
    const removed = await handleTokenVaultRequest(storage, request('DELETE', '/token?role=bot'))
    const removedAgain = await handleTokenVaultRequest(storage, request('DELETE', '/token?role=bot'))

    expect(await first.json()).toEqual({ previous: null })
    expect(await second.json()).toEqual({ previous: botToken() })
    expect(await removed.json()).toEqual({ previous: replacement })
    expect(await removedAgain.json()).toEqual({ previous: null })
  })

  it('知らない役割は受け付けない', async () => {
    const response = await handleTokenVaultRequest(createFakeTokenStorage(), request('GET', '/token?role=viewer'))

    expect(response.status).toBe(400)
  })

  describe('置き換え（/token/replace）', () => {
    const refreshed = botToken({ accessToken: '取り直したアクセストークン', refreshToken: '取り直したリフレッシュトークン' })
    const expected = { userId: '67890', refreshToken: '旧botのリフレッシュトークン' }

    it('保存済みのトークンが期待どおりなら置き換える', async () => {
      const storage = createFakeTokenStorage()
      await handleTokenVaultRequest(storage, request('PUT', '/token?role=bot', botToken()))

      const response = await handleTokenVaultRequest(storage, request('POST', '/token/replace?role=bot', { expected, next: refreshed }))

      expect(await response.json()).toEqual({ result: 'replaced' })
      expect(await (await handleTokenVaultRequest(storage, request('GET', '/token?role=bot'))).json()).toEqual(refreshed)
    })

    it('切断されて（消されて）いたら書き込まず、消えたことを返す', async () => {
      const storage = createFakeTokenStorage()

      const response = await handleTokenVaultRequest(storage, request('POST', '/token/replace?role=bot', { expected, next: refreshed }))

      expect(await response.json()).toEqual({ result: 'missing' })
      expect((await handleTokenVaultRequest(storage, request('GET', '/token?role=bot'))).status).toBe(404)
    })

    it('付け替えられていたら書き込まず、変わったことを返す', async () => {
      const storage = createFakeTokenStorage()
      const replacement = botToken({ refreshToken: '新botのリフレッシュトークン', userId: '11111', login: 'atarashii_bot' })
      await handleTokenVaultRequest(storage, request('PUT', '/token?role=bot', replacement))

      const response = await handleTokenVaultRequest(storage, request('POST', '/token/replace?role=bot', { expected, next: refreshed }))

      expect(await response.json()).toEqual({ result: 'changed' })
      expect(await (await handleTokenVaultRequest(storage, request('GET', '/token?role=bot'))).json()).toEqual(replacement)
    })
  })
})

describe('migrateLegacyTokens', () => {
  it('KVに残っているトークンを保管庫へ移し、KVからは消す', async () => {
    const storage = createFakeTokenStorage()
    const legacyStore = createFakeStore({
      'twitch-token': JSON.stringify(botToken({ userId: '12345', login: 'haishinsha' })),
      'twitch-token:bot': JSON.stringify(botToken()),
      'overlay-key': '関係のないキー',
    })

    await migrateLegacyTokens(storage, legacyStore)

    expect(await (await handleTokenVaultRequest(storage, request('GET', '/token?role=broadcaster'))).json()).toMatchObject({ login: 'haishinsha' })
    expect(await (await handleTokenVaultRequest(storage, request('GET', '/token?role=bot'))).json()).toMatchObject({ login: 'furui_bot' })
    expect([...legacyStore.entries.keys()]).toEqual(['overlay-key'])
  })

  it('移したあとは、切断で消えたトークンをKVから戻さない', async () => {
    const storage = createFakeTokenStorage()
    await migrateLegacyTokens(storage, createFakeStore({ 'twitch-token:bot': JSON.stringify(botToken()) }))
    await handleTokenVaultRequest(storage, request('DELETE', '/token?role=bot'))

    // KVの書き込みは他の拠点へ届くまで遅れるので、消したはずの古い値が見えることがある
    await migrateLegacyTokens(storage, createFakeStore({ 'twitch-token:bot': JSON.stringify(botToken()) }))

    expect((await handleTokenVaultRequest(storage, request('GET', '/token?role=bot'))).status).toBe(404)
  })

  it('KVにトークンが無ければ、何も移さない', async () => {
    const storage = createFakeTokenStorage()

    await migrateLegacyTokens(storage, createFakeStore())

    expect((await handleTokenVaultRequest(storage, request('GET', '/token?role=broadcaster'))).status).toBe(404)
  })
})
