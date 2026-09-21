/**
 * botとしてのチャット送信
 *
 * 「botのトークンを取り出して、配信者のチャンネルへ送る」という定型を1か所に置く。
 * 管理画面からの手打ち（bot-routes.ts）、コマンドへの応答、アラートのトリガーによる送信（webhook-routes.ts）で使う。
 * 普通の発言（sendAsBot）と、モデレーターとして送るアナウンス（announceAsBot）の2通りがある。
 *
 * 注意: 送り先は常に TWITCH_BROADCASTER_ID のチャンネルで、送り主は接続しているbot本人（呼び出し側は指定しない）。
 */
import type { Context } from './http'
import { getAccessToken } from './token'
import type { AnnouncementColor } from './twitch'

/**
 * botの名前で配信者のチャンネルへ1通送る。
 *
 * @throws AuthError botが未接続・トークンを更新できない
 * @throws TwitchApiError Twitchが拒否した、または受け取ったうえで送信しなかった（AutoModの保留など）
 */
export const sendAsBot = async (context: Pick<Context, 'env' | 'twitch' | 'now'>, message: string): Promise<void> => {
  const { env, twitch, now } = context
  const token = await getAccessToken(env.STORE, 'bot', twitch, now)
  await twitch.sendChatMessage(token.accessToken, {
    broadcasterId: env.TWITCH_BROADCASTER_ID,
    senderId: token.userId,
    message,
  })
}

/**
 * botの名前でアナウンス（色の付いた帯で出る発言）を1通送る。
 *
 * 通常のチャット送信と違い、botがこのチャンネルのモデレーターにされていることが前提で、
 * されていなければTwitchが拒否する（呼び出し側は失敗として記録する）。
 *
 * @throws AuthError botが未接続・トークンを更新できない
 * @throws TwitchApiError Twitchが拒否した（botがモデレーターでない、スコープが足りないなど）
 */
export const announceAsBot = async (
  context: Pick<Context, 'env' | 'twitch' | 'now'>,
  announcement: { message: string; color: AnnouncementColor },
): Promise<void> => {
  const { env, twitch, now } = context
  const token = await getAccessToken(env.STORE, 'bot', twitch, now)
  await twitch.sendChatAnnouncement(token.accessToken, {
    broadcasterId: env.TWITCH_BROADCASTER_ID,
    // アナウンスを送るモデレーターは bot 自身（トークンの持ち主と一致している必要がある）
    moderatorId: token.userId,
    ...announcement,
  })
}
