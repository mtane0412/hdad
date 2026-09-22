/**
 * cron による配信の記録の収集
 *
 * Twitchには過去の視聴者数の推移を返すAPIがなく、取れるのは「いま」の値だけなので、定期的に取得してデータベースへ貯める。
 * 1回の収集で、配信の状態（配信中ならセッションの開始・継続と視聴者数、配信していなければセッションの終了）と、フォロワー数を記録し、
 * あわせて古くなった「その配信で初めての発言」の記録（first_chatters）を消す。
 *
 * 注意: トークンが無い・更新できない・Twitchが失敗を返したときは、黙って飛ばさない。
 * 失敗をデータベース（collection_failures）に記録したうえでエラーを投げ、cron の実行も失敗として残す（Fail-Fast）。
 */
import { deleteOldFirstChatters } from './chat-store'
import type { Database } from './database'
import { closeOpenSessions, recordFailure, recordFollowerTotal, recordLiveStream } from './stats-store'
import type { KeyValueStore } from './store'
import { AuthError, getAccessToken } from './token'
import { TwitchApiError, type TwitchClient } from './twitch'

const UNAUTHORIZED = 401

/**
 * 「その配信で初めての発言」の記録を残しておく期間（ミリ秒）。
 *
 * 判定に使うのは配信中の区切りのぶんだけなので、終わった配信のぶんは残しておく意味がない。
 * それでも1日ぶん残すのは、配信をまたいで遅れて届いた通知（Twitchの再送）にも同じ答えを返すためである。
 * 配信中の区切りのぶんは、この期間を過ぎても消さない（deleteOldFirstChatters を参照）。
 */
const FIRST_CHATTER_RETENTION_MS = 24 * 60 * 60 * 1000

export interface CollectStatsOptions {
  db: Database
  store: KeyValueStore
  twitch: Pick<TwitchClient, 'refresh' | 'getLiveStream' | 'getFollowerTotal'>
  broadcasterId: string
  /** 現在時刻（ミリ秒） */
  now: number
}

/** 失敗の記録に残すコード。AuthError はそのコード（not-logged-in など）を使う */
const toFailureCode = (error: unknown): string => {
  if (error instanceof AuthError) return error.code
  if (error instanceof TwitchApiError) return 'twitch-error'
  return 'internal-error'
}

const collect = async ({ db, store, twitch, broadcasterId, now }: CollectStatsOptions): Promise<void> => {
  let token = await getAccessToken(store, 'broadcaster', twitch, now)
  let refreshed = false

  /** 保管しているトークンでTwitchを呼ぶ。期限内でもTwitch側で無効になっていることがあるので、401なら1回だけ取り直してやり直す */
  const callTwitch = async <Result>(call: (accessToken: string) => Promise<Result>): Promise<Result> => {
    try {
      return await call(token.accessToken)
    } catch (error) {
      const tokenRejected = error instanceof TwitchApiError && error.status === UNAUTHORIZED
      if (!tokenRejected || refreshed) throw error
      refreshed = true
      token = await getAccessToken(store, 'broadcaster', twitch, now, { forceRefresh: true })
      return await call(token.accessToken)
    }
  }

  // 片方の取得に失敗しても、先に取れたほうの記録は残す
  const stream = await callTwitch((accessToken) => twitch.getLiveStream(accessToken, broadcasterId))
  if (stream) await recordLiveStream(db, stream, now)
  else await closeOpenSessions(db, now)

  const followerTotal = await callTwitch((accessToken) => twitch.getFollowerTotal(accessToken, broadcasterId))
  await recordFollowerTotal(db, followerTotal, now)

  // 配信を重ねるほど行が積み上がるので、収集のついでに古いぶんを消す
  await deleteOldFirstChatters(db, now - FIRST_CHATTER_RETENTION_MS)
}

/**
 * 1回分の収集を行う。
 *
 * @throws AuthError 未ログイン・再ログインが必要（失敗を記録したうえで投げる）
 * @throws TwitchApiError Twitchが失敗を返した（同上）
 */
export const collectStats = async (options: CollectStatsOptions): Promise<void> => {
  try {
    await collect(options)
  } catch (error) {
    await recordFailure(options.db, toFailureCode(error), error instanceof Error ? error.message : String(error), options.now)
    throw error
  }
}
