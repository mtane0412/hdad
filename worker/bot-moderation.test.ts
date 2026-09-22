/**
 * botによる処分の実行（bot-moderation.ts）のテスト
 *
 * Twitchの呼び出しは代役に差し替え、「どの操作を、どの順番で呼ぶか」を確かめる。特に重要なのは次の2点。
 * - タイムアウト・BANでは、発言を削除してからユーザーを処分すること（BAN後は削除できない場合があるため）
 * - すでにBAN済み・タイムアウト中を表す409を、失敗として扱わないこと
 */
import { describe, expect, it } from 'vitest'
import { punishAsBot } from './bot-moderation'
import { createFakeStore } from './fake-store'
import { saveToken, type StoredToken } from './token'
import { TwitchApiError, type BanToApply, type ChatMessageToDelete, type TwitchClient } from './twitch'

const 現在時刻 = Date.parse('2026-09-21T12:30:00Z')
const 配信者のID = '12345'
const botのID = '67890'

const botのトークン: StoredToken = {
  accessToken: 'botのアクセストークン',
  refreshToken: 'botのリフレッシュトークン',
  expiresAt: 現在時刻 + 60 * 60 * 1000,
  scopes: ['user:bot', 'moderator:manage:banned_users', 'moderator:manage:chat_messages'],
  userId: botのID,
  login: 'haishinsha_bot',
}

/** 処分の対象。荒らしの発言1件 */
const 対象 = { messageId: 'chat-message-1', userId: '11111' }

type モデレーション用のTwitch = Pick<TwitchClient, 'refresh' | 'banUser' | 'deleteChatMessage'>

/** 呼び出しの記録を残すTwitchの代役 */
const Twitchの代役 = (overrides: Partial<モデレーション用のTwitch> = {}) => {
  const 呼んだ操作: string[] = []
  const 削除した発言: ChatMessageToDelete[] = []
  const 処分したユーザー: BanToApply[] = []
  const twitch: モデレーション用のTwitch = {
    refresh: async () => {
      throw new Error('テストで想定していないトークンの更新です（期限内のトークンを渡しています）')
    },
    deleteChatMessage: async (_accessToken, message) => {
      呼んだ操作.push('deleteChatMessage')
      削除した発言.push(message)
    },
    banUser: async (_accessToken, ban) => {
      呼んだ操作.push('banUser')
      処分したユーザー.push(ban)
    },
    ...overrides,
  }
  return { twitch, 呼んだ操作, 削除した発言, 処分したユーザー }
}

const 環境を作る = async () => {
  const store = createFakeStore()
  await saveToken(store, 'bot', botのトークン)
  return { STORE: store, TWITCH_BROADCASTER_ID: 配信者のID }
}

/** テストで使う文脈。punishAsBot が見るのは環境・Twitch・現在時刻だけ */
const 文脈 = async (twitch: モデレーション用のTwitch) => {
  const env = await 環境を作る()
  return { env, twitch, now: 現在時刻 }
}

describe('punishAsBot', () => {
  it('削除の処分では、発言の削除だけを行う', async () => {
    const 代役 = Twitchの代役()

    await punishAsBot(await 文脈(代役.twitch), { type: 'delete' }, 対象)

    expect(代役.呼んだ操作).toEqual(['deleteChatMessage'])
    expect(代役.削除した発言[0]).toMatchObject({ broadcasterId: 配信者のID, moderatorId: botのID, messageId: 'chat-message-1' })
  })

  it('タイムアウトの処分では、発言を削除してからユーザーをタイムアウトする', async () => {
    const 代役 = Twitchの代役()

    await punishAsBot(await 文脈(代役.twitch), { type: 'timeout', durationSeconds: 600 }, 対象)

    // 削除が先。BANしたあとでは発言を削除できない場合がある
    expect(代役.呼んだ操作).toEqual(['deleteChatMessage', 'banUser'])
    expect(代役.処分したユーザー[0]).toMatchObject({ broadcasterId: 配信者のID, moderatorId: botのID, userId: '11111', durationSeconds: 600 })
  })

  it('BANの処分では、発言を削除してから期限なしでBANする', async () => {
    const 代役 = Twitchの代役()

    await punishAsBot(await 文脈(代役.twitch), { type: 'ban' }, 対象)

    expect(代役.呼んだ操作).toEqual(['deleteChatMessage', 'banUser'])
    // 期限を渡さないと、Twitchは期限のないBANとして扱う
    expect(代役.処分したユーザー[0]?.durationSeconds).toBeUndefined()
  })

  it('すでにBAN済み・タイムアウト中（409）は、失敗にせず処分済みとして扱う', async () => {
    const 代役 = Twitchの代役({
      banUser: async () => {
        throw new TwitchApiError(409, 'すでにタイムアウト中のユーザーです')
      },
    })

    await expect(punishAsBot(await 文脈(代役.twitch), { type: 'ban' }, 対象)).resolves.toBeUndefined()
  })

  it('409以外の失敗は投げ直す（呼び出し側が収集の失敗として記録する）', async () => {
    const 代役 = Twitchの代役({
      banUser: async () => {
        throw new TwitchApiError(401, 'botがこのチャンネルのモデレーターではありません')
      },
    })

    await expect(punishAsBot(await 文脈(代役.twitch), { type: 'ban' }, 対象)).rejects.toThrow(TwitchApiError)
  })
})
