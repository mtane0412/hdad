/**
 * トークンの保管と更新（token.ts）のテスト
 *
 * アクセストークンは約4時間で切れるため、期限が近ければリフレッシュトークンで取り直して保存し直す。
 * 取り直せない（リフレッシュトークンが無効）場合は、黙って古いトークンを返さず、再ログインを求めるエラーにする。
 * 配信者（broadcaster）とチャットボット（bot）の2つのアカウントぶんを、役割ごとに別のキーで保管する。
 * 保管先は Durable Object（token-vault.ts）で、テストではメモリ上で同じ処理を動かす代役（fake-token-vault.ts）を使う。
 */
import { describe, expect, it, vi } from 'vitest'
import { createFakeTokenVault } from './fake-token-vault'
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
    const store = createFakeTokenVault().namespace
    await saveToken(store, 'broadcaster', savedToken(now + oneHour))
    expect(await loadToken(store, 'broadcaster')).toEqual(savedToken(now + oneHour))
  })

  it('まだ保存していなければ null を返す', async () => {
    expect(await loadToken(createFakeTokenVault().namespace, 'broadcaster')).toBeNull()
  })

  it('保存内容が壊れていたらエラーになる', async () => {
    const store = createFakeTokenVault({ broadcaster: '{"accessToken":"これだけ"}' }).namespace
    await expect(loadToken(store, 'broadcaster')).rejects.toThrow('broadcaster')
  })

  it('配信者とbotのトークンは別のキーに保管され、互いに上書きしない', async () => {
    const vault = createFakeTokenVault()
    const store = vault.namespace

    await saveToken(store, 'broadcaster', savedToken(now + oneHour))
    await saveToken(store, 'bot', { ...savedToken(now + oneHour), userId: '67890', login: 'haishinsha_bot' })

    expect(await loadToken(store, 'broadcaster')).toMatchObject({ login: 'haishinsha' })
    expect(await loadToken(store, 'bot')).toMatchObject({ login: 'haishinsha_bot' })
    expect([...vault.values.keys()]).toEqual(['broadcaster', 'bot'])
  })

  it('botを接続していなくても、配信者のトークンは読める', async () => {
    const store = createFakeTokenVault().namespace
    await saveToken(store, 'broadcaster', savedToken(now + oneHour))

    expect(await loadToken(store, 'bot')).toBeNull()
  })
})

describe('deleteToken', () => {
  it('役割を指定して消すと、その役割のトークンだけが消える', async () => {
    const store = createFakeTokenVault().namespace
    await saveToken(store, 'broadcaster', savedToken(now + oneHour))
    await saveToken(store, 'bot', savedToken(now + oneHour))

    await deleteToken(store, 'bot')

    expect(await loadToken(store, 'bot')).toBeNull()
    expect(await loadToken(store, 'broadcaster')).not.toBeNull()
  })

  it('保存されていなくてもエラーにならない', async () => {
    await expect(deleteToken(createFakeTokenVault().namespace, 'bot')).resolves.toBeUndefined()
  })
})

describe('getAccessToken', () => {
  it('期限に余裕があれば、保存済みのトークンをそのまま返す', async () => {
    const store = createFakeTokenVault().namespace
    await saveToken(store, 'broadcaster', savedToken(now + oneHour))
    const twitch = twitchRefreshSucceeds()

    const token = await getAccessToken(store, 'broadcaster', twitch, now)

    expect(token.accessToken).toBe('保存済みのアクセストークン')
    expect(twitch.refresh).not.toHaveBeenCalled()
  })

  it('期限が近ければ、リフレッシュトークンで取り直して保存し直す', async () => {
    const store = createFakeTokenVault().namespace
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
    const store = createFakeTokenVault().namespace
    await saveToken(store, 'broadcaster', savedToken(now + oneHour))
    const twitch = twitchRefreshSucceeds()

    const token = await getAccessToken(store, 'broadcaster', twitch, now, { forceRefresh: true })

    expect(token.accessToken).toBe('新しいアクセストークン')
  })

  it('一度もログインしていなければ、未ログインのエラーになる', async () => {
    await expect(getAccessToken(createFakeTokenVault().namespace, 'broadcaster', twitchRefreshSucceeds(), now)).rejects.toMatchObject({
      name: 'AuthError',
      code: 'not-logged-in',
    })
  })

  it('botを接続していなければ、botの接続を促すエラーになる', async () => {
    const error = await getAccessToken(createFakeTokenVault().namespace, 'bot', twitchRefreshSucceeds(), now).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AuthError)
    expect(error).toMatchObject({ code: 'not-logged-in' })
    // 配信者のログインと取り違えないよう、botの接続を促す文言にする
    expect((error as AuthError).message).toContain('bot')
  })

  it('リフレッシュトークンが無効なら、再ログインを求めるエラーになる', async () => {
    const store = createFakeTokenVault().namespace
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
    const store = createFakeTokenVault().namespace
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
      const store = createFakeTokenVault().namespace
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
      const store = createFakeTokenVault().namespace
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
      const store = createFakeTokenVault().namespace
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

    it('Twitchの更新のあと、保管庫への書き戻しの直前に切断されても、旧トークンを書き戻さない（issue #220）', async () => {
      const vault = createFakeTokenVault()
      await saveToken(vault.namespace, 'bot', savedToken(now + 30 * 1000))
      const twitch = twitchRefreshSucceeds()
      // Twitchの更新が済んだあと、保管庫へ最初の書き込みの要求が届いたら、その処理の直前に切断を割り込ませる。
      // 読み直し（GET）と書き込みが別々の要求だと、読み直しでは確かめが通り、書き込みで旧トークンが書き戻される
      let interrupted = false
      const interrupting = {
        idFromName: vault.namespace.idFromName,
        get: (id: DurableObjectId) => ({
          fetch: async (request: Request) => {
            if (!interrupted && twitch.refresh.mock.calls.length > 0 && request.method !== 'GET') {
              interrupted = true
              await deleteToken(vault.namespace, 'bot')
            }
            return vault.namespace.get(id).fetch(request)
          },
        }),
      }

      const error = await getAccessToken(interrupting, 'bot', twitch, now).catch((caught: unknown) => caught)

      expect(await loadToken(vault.namespace, 'bot')).toBeNull()
      expect(error).toMatchObject({ name: 'AuthError', code: 'not-logged-in' })
    })
  })
})
