/**
 * botによる処分の実行（bot-moderation.ts）のテスト
 *
 * Twitchの呼び出しは代役に差し替え、「どの操作を、どの順番で呼ぶか」を確かめる。特に重要なのは次の2点。
 * - タイムアウト・BANでは、発言を削除してからユーザーを処分すること（BAN後は削除できない場合があるため）
 * - すでにBAN済み・タイムアウト中を表す409を、失敗として扱わないこと
 */
import { describe, expect, it } from 'vitest'
import { AUTO_MODERATION_REASON, punishAsBot } from './bot-moderation'
import { createFakeTokenVault } from './fake-token-vault'
import { saveToken, type StoredToken } from './token'
import { TwitchApiError, type BanToApply, type ChatMessageToDelete, type TwitchClient } from './twitch'

const NOW = Date.parse('2026-09-21T12:30:00Z')
const BROADCASTER_ID = '12345'
const BOT_ID = '67890'

const BOT_TOKEN: StoredToken = {
  accessToken: 'botのアクセストークン',
  refreshToken: 'botのリフレッシュトークン',
  expiresAt: NOW + 60 * 60 * 1000,
  scopes: ['user:bot', 'moderator:manage:banned_users', 'moderator:manage:chat_messages'],
  userId: BOT_ID,
  login: 'haishinsha_bot',
}

/** 処分の対象。荒らしの発言1件 */
const target = { messageId: 'chat-message-1', userId: '11111' }

type moderationTwitch = Pick<TwitchClient, 'refresh' | 'banUser' | 'deleteChatMessage'>

/** 呼び出しの記録を残すTwitchの代役 */
const fakeTwitch = (overrides: Partial<moderationTwitch> = {}) => {
  const calledOperations: string[] = []
  const deletedMessages: ChatMessageToDelete[] = []
  const sanctionedUsers: BanToApply[] = []
  const twitch: moderationTwitch = {
    refresh: async () => {
      throw new Error('テストで想定していないトークンの更新です（期限内のトークンを渡しています）')
    },
    deleteChatMessage: async (_accessToken, message) => {
      calledOperations.push('deleteChatMessage')
      deletedMessages.push(message)
    },
    banUser: async (_accessToken, ban) => {
      calledOperations.push('banUser')
      sanctionedUsers.push(ban)
    },
    ...overrides,
  }
  return { twitch, calledOperations, deletedMessages, sanctionedUsers }
}

const createEnv = async () => {
  const tokens = createFakeTokenVault().namespace
  await saveToken(tokens, 'bot', BOT_TOKEN)
  return { TOKENS: tokens, TWITCH_BROADCASTER_ID: BROADCASTER_ID }
}

/** テストで使う文脈。punishAsBot が見るのは環境・Twitch・現在時刻だけ */
const context = async (twitch: moderationTwitch) => {
  const env = await createEnv()
  return { env, twitch, now: NOW }
}

describe('punishAsBot', () => {
  it('削除の処分では、発言の削除だけを行う', async () => {
    const fake = fakeTwitch()

    await punishAsBot(await context(fake.twitch), { type: 'delete' }, target)

    expect(fake.calledOperations).toEqual(['deleteChatMessage'])
    expect(fake.deletedMessages[0]).toMatchObject({ broadcasterId: BROADCASTER_ID, moderatorId: BOT_ID, messageId: 'chat-message-1' })
  })

  it('タイムアウトの処分では、発言を削除してからユーザーをタイムアウトする', async () => {
    const fake = fakeTwitch()

    await punishAsBot(await context(fake.twitch), { type: 'timeout', durationSeconds: 600 }, target)

    // 削除が先。BANしたあとでは発言を削除できない場合がある
    expect(fake.calledOperations).toEqual(['deleteChatMessage', 'banUser'])
    expect(fake.sanctionedUsers[0]).toMatchObject({ broadcasterId: BROADCASTER_ID, moderatorId: BOT_ID, userId: '11111', durationSeconds: 600 })
  })

  it('BANの処分では、発言を削除してから期限なしでBANする', async () => {
    const fake = fakeTwitch()

    await punishAsBot(await context(fake.twitch), { type: 'ban' }, target)

    expect(fake.calledOperations).toEqual(['deleteChatMessage', 'banUser'])
    // 期限を渡さないと、Twitchは期限のないBANとして扱う
    expect(fake.sanctionedUsers[0]?.durationSeconds).toBeUndefined()
  })

  it('すでにBAN済み・タイムアウト中（409）は、失敗にせず処分済みとして扱う', async () => {
    const fake = fakeTwitch({
      banUser: async () => {
        throw new TwitchApiError(409, 'すでにタイムアウト中のユーザーです')
      },
    })

    await expect(punishAsBot(await context(fake.twitch), { type: 'ban' }, target)).resolves.toBeUndefined()
  })

  it('409以外の失敗は投げ直す（呼び出し側が収集の失敗として記録する）', async () => {
    const fake = fakeTwitch({
      banUser: async () => {
        throw new TwitchApiError(401, 'botがこのチャンネルのモデレーターではありません')
      },
    })

    await expect(punishAsBot(await context(fake.twitch), { type: 'ban' }, target)).rejects.toThrow(TwitchApiError)
  })

  it('理由を渡さなければ、自動モデレーションによる処分としてTwitchに記録する', async () => {
    const fake = fakeTwitch()

    await punishAsBot(await context(fake.twitch), { type: 'ban' }, target)

    expect(fake.sanctionedUsers[0]?.reason).toBe(AUTO_MODERATION_REASON)
  })

  it('理由を渡せば、その理由でTwitchに記録する（配信者が手で処分したときなど）', async () => {
    const fake = fakeTwitch()

    await punishAsBot(await context(fake.twitch), { type: 'timeout', durationSeconds: 600 }, target, '配信者がコメントビューアーから処分')

    expect(fake.sanctionedUsers[0]?.reason).toBe('配信者がコメントビューアーから処分')
  })

  it('消す発言を指定しなければ（messageId が null）、発言は削除せずにユーザーだけを処分する', async () => {
    // Twitch はタイムアウト・BANした人の発言をまとめて消すので、手で処分するときは削除を先に行わない
    const fake = fakeTwitch()

    await punishAsBot(await context(fake.twitch), { type: 'ban' }, { messageId: null, userId: '11111' })

    expect(fake.calledOperations).toEqual(['banUser'])
  })
})

