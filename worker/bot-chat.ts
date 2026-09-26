/**
 * botとしてのチャット送信
 *
 * 「botのトークンを取り出して、配信者のチャンネルへ送る」という定型を1か所に置く。
 * 管理画面からの手打ち（bot-routes.ts）、コマンドへの応答、アラートのトリガーによる送信（webhook-routes.ts）で使う。
 * 普通の発言（sendAsBot）と、モデレーターとして送るアナウンス（announceAsBot）・シャウトアウト（shoutoutAsBot）がある。
 *
 * 注意: 送り先は常に TWITCH_BROADCASTER_ID のチャンネルで、送り主は接続しているbot本人（呼び出し側は指定しない）。
 */
import { reserveAnnouncementSlot } from './chat-store'
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
 * アナウンス（POST /helix/chat/announcements）はそのエンドポイント自身の制限として2秒に1回しか送れない。
 * 別々のEventSub通知が2秒以内に続くと2通目が429で拒否されてしまうため、送る前に送信枠を確保し
 * （reserveAnnouncementSlot。同時に届いた通知の間でも取り合いにならない）、自分の順番まで待ってから送る。
 *
 * @throws AuthError botが未接続・トークンを更新できない
 * @throws Error アナウンスが詰まっていて、待ち時間の上限までに送信枠を確保できない
 * @throws TwitchApiError Twitchが拒否した（botがモデレーターでない、スコープが足りないなど）
 */
export const announceAsBot = async (
  context: Pick<Context, 'env' | 'twitch' | 'now' | 'wait'>,
  announcement: { message: string; color: AnnouncementColor },
): Promise<void> => {
  const { env, twitch, now, wait } = context
  // トークンの取り出しを枠の確保より先に行う。逆にすると、トークンを取れずに送れなかったときでも
  // 枠を消費してしまい、あとから届くアナウンスを無駄に待たせる
  const token = await getAccessToken(env.STORE, 'bot', twitch, now)

  const waitMilliseconds = await reserveAnnouncementSlot(env.DB, env.TWITCH_BROADCASTER_ID, now)
  if (waitMilliseconds === null) {
    throw new Error('アナウンスは2秒に1回しか送れません。短い間にアナウンスが続いたため、このアナウンスは送りませんでした')
  }
  if (waitMilliseconds > 0) await wait(waitMilliseconds)

  await twitch.sendChatAnnouncement(token.accessToken, {
    broadcasterId: env.TWITCH_BROADCASTER_ID,
    // アナウンスを送るモデレーターは bot 自身（トークンの持ち主と一致している必要がある）
    moderatorId: token.userId,
    ...announcement,
  })
}

/**
 * botの名前でシャウトアウト（相手の配信者を紹介するTwitch組み込みの機能）を1件送る。
 *
 * アナウンスと同じく、botがこのチャンネルのモデレーターにされていることが前提である
 * （されていなければTwitchが拒否し、呼び出し側が失敗として記録する）。
 *
 * アナウンスと違って送信枠の確保はしない。Twitchはシャウトアウトの間隔を制限している（同じチャンネルから2分に1回、
 * 同じ相手には60分に1回）が、待てば送れるアナウンスの2秒とは桁が違い、待つあいだTwitchへ応答を返せないためである。
 * 制限に当たった場合は 429 が上がり、呼び出し側が失敗として記録する。
 *
 * @param toBroadcasterId 紹介する相手（配信者）のユーザーID
 * @throws AuthError botが未接続・トークンを更新できない
 * @throws TwitchApiError Twitchが拒否した（botがモデレーターでない、スコープが足りない、間隔の制限に当たった）
 */
export const shoutoutAsBot = async (context: Pick<Context, 'env' | 'twitch' | 'now'>, toBroadcasterId: string): Promise<void> => {
  const { env, twitch, now } = context
  const token = await getAccessToken(env.STORE, 'bot', twitch, now)
  await twitch.sendShoutout(token.accessToken, {
    broadcasterId: env.TWITCH_BROADCASTER_ID,
    // シャウトアウトを送るモデレーターは bot 自身（トークンの持ち主と一致している必要がある）
    moderatorId: token.userId,
    toBroadcasterId,
  })
}
