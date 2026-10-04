/**
 * トークンの保管と更新（token.ts）のテスト
 *
 * アクセストークンは約4時間で切れるため、期限が近ければリフレッシュトークンで取り直して保存し直す。
 * 取り直せない（リフレッシュトークンが無効）場合は、黙って古いトークンを返さず、再ログインを求めるエラーにする。
 * 配信者（broadcaster）とチャットボット（bot）の2つのアカウントぶんを、役割ごとに別のキーで保管する。
 */
import { describe, expect, it, vi } from 'vitest'
import { createFakeStore } from './fake-store'
import { AuthError, deleteToken, getAccessToken, loadToken, saveToken, type StoredToken } from './token'
import { TwitchApiError } from './twitch'

const now = Date.UTC(2026, 8, 21, 12, 0, 0)
const oneHour = 60 * 60 * 1000

const savedToken = (expiresAt: number): StoredToken => ({
  accessToken: '保存済みのアクセストークン',
  refreshToken: '保存済みのリフレッシュトークン',
  expiresAt,
  scopes: ['channel:read:redemptions'],
  userId: '12345',
  login: 'haishinsha',
})

const twitchRefreshSucceeds = () => ({
  refresh: vi.fn(async () => ({ accessToken: '新しいアクセストークン', refreshToken: '新しいリフレッシュトークン', expiresIn: 14400 })),
})

describe('saveToken / loadToken', () => {
  it('保存したトークンをそのまま読み出せる', async () => {
    const store = createFakeStore()
    await saveToken(store, 'broadcaster', savedToken(now + oneHour))
    expect(await loadToken(store, 'broadcaster')).toEqual(savedToken(now + oneHour))
  })

  it('まだ保存していなければ null を返す', async () => {
    expect(await loadToken(createFakeStore(), 'broadcaster')).toBeNull()
  })

  it('保存内容が壊れていたらエラーになる', async () => {
    const store = createFakeStore({ 'twitch-token': '{"accessToken":"これだけ"}' })
    await expect(loadToken(store, 'broadcaster')).rejects.toThrow('twitch-token')
  })

  it('配信者とbotのトークンは別のキーに保管され、互いに上書きしない', async () => {
    const store = createFakeStore()

    await saveToken(store, 'broadcaster', savedToken(now + oneHour))
    await saveToken(store, 'bot', { ...savedToken(now + oneHour), userId: '67890', login: 'haishinsha_bot' })

    expect(await loadToken(store, 'broadcaster')).toMatchObject({ login: 'haishinsha' })
    expect(await loadToken(store, 'bot')).toMatchObject({ login: 'haishinsha_bot' })
    // 配信者のキーは、既に保存済みのトークンを読み続けられるよう据え置く
    expect([...store.entries.keys()]).toEqual(['twitch-token', 'twitch-token:bot'])
  })

  it('botを接続していなくても、配信者のトークンは読める', async () => {
    const store = createFakeStore()
    await saveToken(store, 'broadcaster', savedToken(now + oneHour))

    expect(await loadToken(store, 'bot')).toBeNull()
  })
})

describe('deleteToken', () => {
  it('役割を指定して消すと、その役割のトークンだけが消える', async () => {
    const store = createFakeStore()
    await saveToken(store, 'broadcaster', savedToken(now + oneHour))
    await saveToken(store, 'bot', savedToken(now + oneHour))

    await deleteToken(store, 'bot')

    expect(await loadToken(store, 'bot')).toBeNull()
    expect(await loadToken(store, 'broadcaster')).not.toBeNull()
  })

  it('保存されていなくてもエラーにならない', async () => {
    await expect(deleteToken(createFakeStore(), 'bot')).resolves.toBeUndefined()
  })
})

describe('getAccessToken', () => {
  it('期限に余裕があれば、保存済みのトークンをそのまま返す', async () => {
    const store = createFakeStore()
    await saveToken(store, 'broadcaster', savedToken(now + oneHour))
    const twitch = twitchRefreshSucceeds()

    const token = await getAccessToken(store, 'broadcaster', twitch, now)

    expect(token.accessToken).toBe('保存済みのアクセストークン')
    expect(twitch.refresh).not.toHaveBeenCalled()
  })

  it('期限が近ければ、リフレッシュトークンで取り直して保存し直す', async () => {
    const store = createFakeStore()
    await saveToken(store, 'broadcaster', savedToken(now + 30 * 1000))
    const twitch = twitchRefreshSucceeds()

    const token = await getAccessToken(store, 'broadcaster', twitch, now)

    expect(twitch.refresh).toHaveBeenCalledWith('保存済みのリフレッシュトークン')
    expect(token).toMatchObject({
      accessToken: '新しいアクセストークン',
      refreshToken: '新しいリフレッシュトークン',
      expiresAt: now + 14400 * 1000,
      userId: '12345',
    })
    expect(await loadToken(store, 'broadcaster')).toEqual(token)
  })

  it('forceRefresh を指定すると、期限に余裕があっても取り直す（Twitchに401を返されたとき用）', async () => {
    const store = createFakeStore()
    await saveToken(store, 'broadcaster', savedToken(now + oneHour))
    const twitch = twitchRefreshSucceeds()

    const token = await getAccessToken(store, 'broadcaster', twitch, now, { forceRefresh: true })

    expect(token.accessToken).toBe('新しいアクセストークン')
  })

  it('一度もログインしていなければ、未ログインのエラーになる', async () => {
    await expect(getAccessToken(createFakeStore(), 'broadcaster', twitchRefreshSucceeds(), now)).rejects.toMatchObject({
      name: 'AuthError',
      code: 'not-logged-in',
    })
  })

  it('botを接続していなければ、botの接続を促すエラーになる', async () => {
    const error = await getAccessToken(createFakeStore(), 'bot', twitchRefreshSucceeds(), now).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AuthError)
    expect(error).toMatchObject({ code: 'not-logged-in' })
    // 配信者のログインと取り違えないよう、botの接続を促す文言にする
    expect((error as AuthError).message).toContain('bot')
  })

  it('リフレッシュトークンが無効なら、再ログインを求めるエラーになる', async () => {
    const store = createFakeStore()
    await saveToken(store, 'broadcaster', savedToken(now - oneHour))
    const twitch = {
      refresh: vi.fn(async () => {
        throw new TwitchApiError(400, 'Invalid refresh token')
      }),
    }

    const error = await getAccessToken(store, 'broadcaster', twitch, now).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AuthError)
    expect(error).toMatchObject({ code: 'relogin-required' })
  })

  it('Twitch側の一時的な障害（5xx）は、再ログインの要求にせずそのまま伝える', async () => {
    const store = createFakeStore()
    await saveToken(store, 'broadcaster', savedToken(now - oneHour))
    const twitch = {
      refresh: vi.fn(async () => {
        throw new TwitchApiError(503, 'Service Unavailable')
      }),
    }

    await expect(getAccessToken(store, 'broadcaster', twitch, now)).rejects.toMatchObject({ name: 'TwitchApiError', status: 503 })
  })
  describe('取り直している間に、保存済みのトークンが変わった場合', () => {
    /** Twitchへの更新を、テストが合図するまで止めておく */
    const twitchRefreshPaused = () => {
      let resume = (): void => undefined
      const paused = new Promise<void>((resolve) => {
        resume = resolve
      })
      const refresh = vi.fn(async () => {
        await paused
        return { accessToken: '旧botの新しいアクセストークン', refreshToken: '旧botの新しいリフレッシュトークン', expiresIn: 14400 }
      })
      return { twitch: { refresh }, resume: () => resume() }
    }

    it('切断された（消された）なら、旧トークンを書き戻さず、未接続のエラーにする', async () => {
      const store = createFakeStore()
      await saveToken(store, 'bot', savedToken(now + 30 * 1000))
      const { twitch, resume } = twitchRefreshPaused()

      const pending = getAccessToken(store, 'bot', twitch, now).catch((caught: unknown) => caught)
      await vi.waitFor(() => expect(twitch.refresh).toHaveBeenCalled())
      await deleteToken(store, 'bot')
      resume()

      expect(await pending).toMatchObject({ name: 'AuthError', code: 'not-logged-in' })
      expect(await loadToken(store, 'bot')).toBeNull()
    })

    it('別のアカウントに付け替えられたなら、新しいトークンを上書きせず、取り直した旧トークンも返さない', async () => {
      const store = createFakeStore()
      await saveToken(store, 'bot', savedToken(now + 30 * 1000))
      const { twitch, resume } = twitchRefreshPaused()
      const replacement: StoredToken = {
        ...savedToken(now + oneHour),
        accessToken: '新botのアクセストークン',
        refreshToken: '新botのリフレッシュトークン',
        userId: '67890',
        login: 'atarashii_bot',
      }

      const pending = getAccessToken(store, 'bot', twitch, now).catch((caught: unknown) => caught)
      await vi.waitFor(() => expect(twitch.refresh).toHaveBeenCalled())
      await saveToken(store, 'bot', replacement)
      resume()

      expect(await pending).toMatchObject({ name: 'AuthError', code: 'token-changed' })
      expect(await loadToken(store, 'bot')).toEqual(replacement)
    })

    it('同じアカウントで接続し直された（リフレッシュトークンが変わった）なら、接続し直したトークンを上書きしない', async () => {
      const store = createFakeStore()
      await saveToken(store, 'bot', savedToken(now + 30 * 1000))
      const { twitch, resume } = twitchRefreshPaused()
      const reconnected: StoredToken = { ...savedToken(now + oneHour), accessToken: '接続し直したアクセストークン', refreshToken: '接続し直したリフレッシュトークン' }

      const pending = getAccessToken(store, 'bot', twitch, now).catch((caught: unknown) => caught)
      await vi.waitFor(() => expect(twitch.refresh).toHaveBeenCalled())
      await saveToken(store, 'bot', reconnected)
      resume()

      expect(await pending).toMatchObject({ name: 'AuthError', code: 'token-changed' })
      expect(await loadToken(store, 'bot')).toEqual(reconnected)
    })
  })
})
