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

const 現在時刻 = Date.UTC(2026, 8, 21, 12, 0, 0)
const 一時間 = 60 * 60 * 1000

const 保存済みトークン = (expiresAt: number): StoredToken => ({
  accessToken: '保存済みのアクセストークン',
  refreshToken: '保存済みのリフレッシュトークン',
  expiresAt,
  scopes: ['channel:read:redemptions'],
  userId: '12345',
  login: 'haishinsha',
})

const 更新に成功するTwitch = () => ({
  refresh: vi.fn(async () => ({ accessToken: '新しいアクセストークン', refreshToken: '新しいリフレッシュトークン', expiresIn: 14400 })),
})

describe('saveToken / loadToken', () => {
  it('保存したトークンをそのまま読み出せる', async () => {
    const store = createFakeStore()
    await saveToken(store, 'broadcaster', 保存済みトークン(現在時刻 + 一時間))
    expect(await loadToken(store, 'broadcaster')).toEqual(保存済みトークン(現在時刻 + 一時間))
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

    await saveToken(store, 'broadcaster', 保存済みトークン(現在時刻 + 一時間))
    await saveToken(store, 'bot', { ...保存済みトークン(現在時刻 + 一時間), userId: '67890', login: 'haishinsha_bot' })

    expect(await loadToken(store, 'broadcaster')).toMatchObject({ login: 'haishinsha' })
    expect(await loadToken(store, 'bot')).toMatchObject({ login: 'haishinsha_bot' })
    // 配信者のキーは、既に保存済みのトークンを読み続けられるよう据え置く
    expect([...store.entries.keys()]).toEqual(['twitch-token', 'twitch-token:bot'])
  })

  it('botを接続していなくても、配信者のトークンは読める', async () => {
    const store = createFakeStore()
    await saveToken(store, 'broadcaster', 保存済みトークン(現在時刻 + 一時間))

    expect(await loadToken(store, 'bot')).toBeNull()
  })
})

describe('deleteToken', () => {
  it('役割を指定して消すと、その役割のトークンだけが消える', async () => {
    const store = createFakeStore()
    await saveToken(store, 'broadcaster', 保存済みトークン(現在時刻 + 一時間))
    await saveToken(store, 'bot', 保存済みトークン(現在時刻 + 一時間))

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
    await saveToken(store, 'broadcaster', 保存済みトークン(現在時刻 + 一時間))
    const twitch = 更新に成功するTwitch()

    const token = await getAccessToken(store, 'broadcaster', twitch, 現在時刻)

    expect(token.accessToken).toBe('保存済みのアクセストークン')
    expect(twitch.refresh).not.toHaveBeenCalled()
  })

  it('期限が近ければ、リフレッシュトークンで取り直して保存し直す', async () => {
    const store = createFakeStore()
    await saveToken(store, 'broadcaster', 保存済みトークン(現在時刻 + 30 * 1000))
    const twitch = 更新に成功するTwitch()

    const token = await getAccessToken(store, 'broadcaster', twitch, 現在時刻)

    expect(twitch.refresh).toHaveBeenCalledWith('保存済みのリフレッシュトークン')
    expect(token).toMatchObject({
      accessToken: '新しいアクセストークン',
      refreshToken: '新しいリフレッシュトークン',
      expiresAt: 現在時刻 + 14400 * 1000,
      userId: '12345',
    })
    expect(await loadToken(store, 'broadcaster')).toEqual(token)
  })

  it('forceRefresh を指定すると、期限に余裕があっても取り直す（Twitchに401を返されたとき用）', async () => {
    const store = createFakeStore()
    await saveToken(store, 'broadcaster', 保存済みトークン(現在時刻 + 一時間))
    const twitch = 更新に成功するTwitch()

    const token = await getAccessToken(store, 'broadcaster', twitch, 現在時刻, { forceRefresh: true })

    expect(token.accessToken).toBe('新しいアクセストークン')
  })

  it('一度もログインしていなければ、未ログインのエラーになる', async () => {
    await expect(getAccessToken(createFakeStore(), 'broadcaster', 更新に成功するTwitch(), 現在時刻)).rejects.toMatchObject({
      name: 'AuthError',
      code: 'not-logged-in',
    })
  })

  it('botを接続していなければ、botの接続を促すエラーになる', async () => {
    const error = await getAccessToken(createFakeStore(), 'bot', 更新に成功するTwitch(), 現在時刻).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AuthError)
    expect(error).toMatchObject({ code: 'not-logged-in' })
    // 配信者のログインと取り違えないよう、botの接続を促す文言にする
    expect((error as AuthError).message).toContain('bot')
  })

  it('リフレッシュトークンが無効なら、再ログインを求めるエラーになる', async () => {
    const store = createFakeStore()
    await saveToken(store, 'broadcaster', 保存済みトークン(現在時刻 - 一時間))
    const twitch = {
      refresh: vi.fn(async () => {
        throw new TwitchApiError(400, 'Invalid refresh token')
      }),
    }

    const error = await getAccessToken(store, 'broadcaster', twitch, 現在時刻).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AuthError)
    expect(error).toMatchObject({ code: 'relogin-required' })
  })

  it('Twitch側の一時的な障害（5xx）は、再ログインの要求にせずそのまま伝える', async () => {
    const store = createFakeStore()
    await saveToken(store, 'broadcaster', 保存済みトークン(現在時刻 - 一時間))
    const twitch = {
      refresh: vi.fn(async () => {
        throw new TwitchApiError(503, 'Service Unavailable')
      }),
    }

    await expect(getAccessToken(store, 'broadcaster', twitch, 現在時刻)).rejects.toMatchObject({ name: 'TwitchApiError', status: 503 })
  })
})
