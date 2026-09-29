/**
 * botによる処分の実行
 *
 * chat-moderation.ts が決めた処分（削除・タイムアウト・BAN）を、botのトークンでTwitchへ伝える。
 * bot-chat.ts と同じく「botのトークンを取り出して、配信者のチャンネルへ操作する」定型を1か所に置く。
 *
 * 注意: タイムアウト・BANでは、発言を削除してからユーザーを処分する。BANしたあとでは、その発言を削除できない場合がある。
 * 注意: すでにBAN済み・タイムアウト中の相手には Twitch が 409 を返す。これは狙いどおりの状態なので失敗として扱わない
 * （失敗にすると、連投のたびに収集の失敗が積み上がる）。
 */
import type { Punishment } from './chat-moderation'
import type { KeyValueStore } from './store'
import { getAccessToken } from './token'
import { TwitchApiError, type TwitchClient } from './twitch'

/** 処分の実行に必要なものだけを受け取る（テストで差し替えやすくするため、Context そのものは要求しない） */
export interface ModerationContext {
  env: { STORE: KeyValueStore; TWITCH_BROADCASTER_ID: string }
  twitch: Pick<TwitchClient, 'refresh' | 'banUser' | 'deleteChatMessage'>
  /** 現在時刻（ミリ秒） */
  now: number
}

/** 処分する発言 */
export interface PunishTarget {
  /**
   * 削除する発言のID。null なら発言は削除せず、ユーザーだけを処分する
   * （配信者が手でタイムアウト・BANするとき。Twitch はその人の発言をまとめて消す）
   */
  messageId: string | null
  /** 処分する発言者のユーザーID */
  userId: string
}

/** Twitchのモデレーターの記録に残る、自動モデレーションの理由。誰の判断による処分かが後から分かるようにする */
export const AUTO_MODERATION_REASON = '自動モデレーション（配信者が登録したルールによる処分）'

/** すでにBAN済み・タイムアウト中であることを表す状態コード */
const ALREADY_PUNISHED = 409

/** すでに処分済み（409）なら飲み込み、それ以外の失敗は投げ直す */
const ignoreAlreadyPunished = async (operation: Promise<void>): Promise<void> => {
  try {
    await operation
  } catch (error) {
    if (error instanceof TwitchApiError && error.status === ALREADY_PUNISHED) return
    throw error
  }
}

/**
 * 決まった処分を、botがモデレーターとして実行する。
 *
 * @param reason Twitchのモデレーターの記録に残る理由（既定は自動モデレーション）
 * @throws AuthError botが未接続・トークンを更新できない
 * @throws TwitchApiError Twitchが拒否した（botがモデレーターでない、スコープが足りないなど）
 */
export const punishAsBot = async (
  context: ModerationContext,
  punishment: Punishment,
  target: PunishTarget,
  reason: string = AUTO_MODERATION_REASON,
): Promise<void> => {
  const { env, twitch, now } = context
  const token = await getAccessToken(env.STORE, 'bot', twitch, now)
  // 操作するモデレーターは bot 自身（トークンの持ち主と一致している必要がある）
  const moderation = { broadcasterId: env.TWITCH_BROADCASTER_ID, moderatorId: token.userId }

  if (target.messageId !== null) {
    await ignoreAlreadyPunished(twitch.deleteChatMessage(token.accessToken, { ...moderation, messageId: target.messageId }))
  }
  if (punishment.type === 'delete') return

  await ignoreAlreadyPunished(
    twitch.banUser(token.accessToken, {
      ...moderation,
      userId: target.userId,
      // 期限を渡さないと、Twitchは期限のないBANとして扱う
      ...(punishment.type === 'timeout' ? { durationSeconds: punishment.durationSeconds } : {}),
      reason,
    }),
  )
}
