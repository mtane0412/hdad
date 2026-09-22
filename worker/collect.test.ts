/**
 * cron による配信の記録の収集（collect.ts）のテスト
 *
 * Twitchのクライアント・KV・D1を差し替え、「配信中か」「トークンが使えるか」に応じて何が記録されるかを確かめる。
 */
import { describe, expect, it } from 'vitest'
import { collectStats } from './collect'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'
import { getSession, listFailures, listFollowerSamples, listSessions } from './stats-store'
import { AuthError, loadToken, saveToken, type StoredToken } from './token'
import { TwitchApiError, type LiveStream, type TwitchClient } from './twitch'

const 現在時刻 = Date.parse('2026-09-21T12:05:00Z')
const 配信者のID = '12345'

const 雑談配信: LiveStream = {
  id: '40000000001',
  startedAt: '2026-09-21T12:00:00.000Z',
  title: '月曜の雑談配信',
  categoryName: 'Just Chatting',
  viewerCount: 42,
}

const 保管中のトークン: StoredToken = {
  accessToken: '保管中のアクセストークン',
  refreshToken: '保管中のリフレッシュトークン',
  expiresAt: 現在時刻 + 60 * 60 * 1000,
  scopes: ['moderator:read:followers'],
  userId: 配信者のID,
  login: 'haishinsha',
}

type 収集用のTwitch = Pick<TwitchClient, 'refresh' | 'getLiveStream' | 'getFollowerTotal'>

const Twitchの代役 = (overrides: Partial<収集用のTwitch> = {}): 収集用のTwitch => ({
  refresh: async () => {
    throw new Error('テストで想定していないトークンの更新です')
  },
  getLiveStream: async () => 雑談配信,
  getFollowerTotal: async () => 1234,
  ...overrides,
})

const 環境を作る = async (token: StoredToken | null = 保管中のトークン) => {
  const db = createFakeDatabase()
  const store = createFakeStore()
  if (token) await saveToken(store, 'broadcaster', token)
  return { db, store }
}

describe('collectStats', () => {
  it('配信中なら、セッション・視聴者数・フォロワー数を記録する', async () => {
    const { db, store } = await 環境を作る()
    const 受け取った引数: string[][] = []
    const twitch = Twitchの代役({
      getLiveStream: async (accessToken, broadcasterId) => {
        受け取った引数.push([accessToken, broadcasterId])
        return 雑談配信
      },
    })

    await collectStats({ db, store, twitch, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(受け取った引数).toEqual([['保管中のアクセストークン', '12345']])
    expect((await getSession(db, 雑談配信.id))?.samples).toEqual([{ sampledAt: '2026-09-21T12:05:00.000Z', viewerCount: 42 }])
    expect(await listFollowerSamples(db)).toEqual([{ sampledAt: '2026-09-21T12:05:00.000Z', followerTotal: 1234 }])
    expect(await listFailures(db)).toEqual([])
  })

  it('配信していなければ、開いているセッションを閉じ、フォロワー数だけを記録する', async () => {
    const { db, store } = await 環境を作る()
    await collectStats({ db, store, twitch: Twitchの代役(), broadcasterId: 配信者のID, now: 現在時刻 })

    const 五分後 = 現在時刻 + 5 * 60 * 1000
    await collectStats({ db, store, twitch: Twitchの代役({ getLiveStream: async () => null }), broadcasterId: 配信者のID, now: 五分後 })

    const session = await getSession(db, 雑談配信.id)
    expect(session?.endedAt).toBe('2026-09-21T12:10:00.000Z')
    expect(session?.samples).toHaveLength(1)
  })

  it('期限内のトークンをTwitchが拒んだら、1回だけ取り直してやり直す', async () => {
    const { db, store } = await 環境を作る()
    const 使われたトークン: string[] = []
    const twitch = Twitchの代役({
      refresh: async () => ({ accessToken: '取り直したアクセストークン', refreshToken: '新しいリフレッシュトークン', expiresIn: 14400 }),
      getLiveStream: async (accessToken) => {
        使われたトークン.push(accessToken)
        if (accessToken === '保管中のアクセストークン') throw new TwitchApiError(401, 'Twitchが 401 を返しました: Invalid OAuth token')
        return 雑談配信
      },
    })

    await collectStats({ db, store, twitch, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(使われたトークン).toEqual(['保管中のアクセストークン', '取り直したアクセストークン'])
    expect((await loadToken(store, 'broadcaster'))?.accessToken).toBe('取り直したアクセストークン')
    expect(await listSessions(db, 現在時刻)).toHaveLength(1)
  })

  it('トークンが保管されていなければ、黙って飛ばさず、失敗を記録してエラーにする', async () => {
    const { db, store } = await 環境を作る(null)

    await expect(collectStats({ db, store, twitch: Twitchの代役(), broadcasterId: 配信者のID, now: 現在時刻 })).rejects.toBeInstanceOf(AuthError)

    expect(await listFailures(db)).toEqual([
      { occurredAt: '2026-09-21T12:05:00.000Z', code: 'not-logged-in', message: expect.stringContaining('ログイン') },
    ])
  })

  it('トークンを更新できなければ、再ログインが必要な失敗として記録する', async () => {
    const { db, store } = await 環境を作る({ ...保管中のトークン, expiresAt: 現在時刻 - 1 })
    const twitch = Twitchの代役({
      refresh: async () => {
        throw new TwitchApiError(400, 'Twitchが 400 を返しました: Invalid refresh token')
      },
    })

    await expect(collectStats({ db, store, twitch, broadcasterId: 配信者のID, now: 現在時刻 })).rejects.toBeInstanceOf(AuthError)

    expect((await listFailures(db))[0]?.code).toBe('relogin-required')
  })

  it('フォロワー数の取得に失敗しても、先に取れた配信の記録は残し、失敗を記録する', async () => {
    const { db, store } = await 環境を作る()
    const twitch = Twitchの代役({
      getFollowerTotal: async () => {
        throw new TwitchApiError(500, 'Twitchが 500 を返しました: Internal Server Error')
      },
    })

    await expect(collectStats({ db, store, twitch, broadcasterId: 配信者のID, now: 現在時刻 })).rejects.toBeInstanceOf(TwitchApiError)

    expect(await listSessions(db, 現在時刻)).toHaveLength(1)
    expect(await listFailures(db)).toEqual([
      { occurredAt: '2026-09-21T12:05:00.000Z', code: 'twitch-error', message: 'Twitchが 500 を返しました: Internal Server Error' },
    ])
  })
})

describe('古い記録の掃除', () => {
  it('保持期間より古い「その配信で初めての発言」の記録を消す（配信を重ねても行が積み上がらないようにするため）', async () => {
    const db = createFakeDatabase()
    const store = createFakeStore()
    await saveToken(store, 'broadcaster', 保管中のトークン)
    const 三十日 = 30 * 24 * 60 * 60 * 1000
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, ?, ?, ?)')
      .run('mukashi-no-haishin', new Date(現在時刻 - 三十日).toISOString(), new Date(現在時刻 - 三十日).toISOString(), '昔の配信', 'Just Chatting')
    const 記録を足す = (chatterUserId: string, at: number): void => {
      db.sqlite
        .prepare('INSERT INTO first_chatters (session_id, chatter_user_id, message_id, first_chatted_at) VALUES (?, ?, ?, ?)')
        .run('mukashi-no-haishin', chatterUserId, `hatsugen-${chatterUserId}`, new Date(at).toISOString())
    }
    記録を足す('mukashi-no-hito', 現在時刻 - 三十日)
    記録を足す('kyou-no-hito', 現在時刻)

    await collectStats({ db, store, twitch: Twitchの代役(), broadcasterId: 配信者のID, now: 現在時刻 })

    expect(db.sqlite.prepare('SELECT chatter_user_id FROM first_chatters').all()).toEqual([{ chatter_user_id: 'kyou-no-hito' }])
  })
})
