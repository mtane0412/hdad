/**
 * cron による配信の記録の収集
 *
 * Twitchには過去の視聴者数の推移を返すAPIがなく、取れるのは「いま」の値だけなので、定期的に取得してデータベースへ貯める。
 * 1回の収集で、配信の状態（配信中ならセッションの開始・継続と視聴者数、配信していなければセッションの終了）と、フォロワー数を記録し、
 * あわせて終わった配信の発言から視聴者の人物像を作り、古くなった記録（first_chatters・stream_chat_messages）を消す。
 *
 * 注意: トークンが無い・更新できない・Twitchが失敗を返したときは、黙って飛ばさない。
 * 失敗をデータベース（collection_failures）に記録したうえでエラーを投げ、cron の実行も失敗として残す（Fail-Fast）。
 */
import type { TextGenerator } from './ai-chat'
import { deleteOldFirstChatters } from './chat-store'
import type { Database } from './database'
import { deleteOldStreamChatMessages, deleteStreamChatMessages, listSummaryTargets, readViewerMessages } from './stream-chat-store'
import { generateViewerSummary } from './viewer-summary'
import { readViewer, updateViewerSummary } from './viewer-store'
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

/**
 * 1回の収集で人物像を作る人数の上限。
 *
 * Workers AI の無料枠（1日10,000 Neurons）を一度に使い切らないための歯止めであり、
 * Workers が1回のリクエストで出せる外部への呼び出し（サブリクエスト）の上限への備えでもある。
 * cron は5分おきに動くので、残った人は次の収集で順に処理される。
 */
export const SUMMARY_BATCH_SIZE = 5

/**
 * 1人ぶんの人物像の材料として読む発言の件数の上限。
 *
 * 話し続ける人ほど行が多くなるので、LLMへ渡す量を一定に抑える（Neurons と D1 の rows read の両方の節約）。
 */
const SUMMARY_MESSAGE_LIMIT = 50

/**
 * 人物像の材料（配信中のチャット）を残しておく期間（ミリ秒）。
 *
 * ふつうは人物像を作った時点で消える（deleteStreamChatMessages）ので、ここで消えるのは、
 * LLMを呼べないまま残った材料（無料枠を使い切った日など）だけである。
 * 配信中の発言まで巻き添えにしないよう、1回の配信より十分に長くとる。
 */
export const STREAM_CHAT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export interface CollectStatsOptions {
  db: Database
  store: KeyValueStore
  /** 人物像を作らせる Workers AI のバインディング（Env.AI） */
  ai: TextGenerator
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

/**
 * 終わった配信の発言から、視聴者の人物像を作る。
 *
 * 材料が残っていること自体が「まだ作っていない」という印なので、作り終えた人のぶんはその場で消す
 * （stream-chat-store.ts）。1回に処理する人数を SUMMARY_BATCH_SIZE までに抑え、残りは次の収集に回す。
 *
 * 注意: LLMの失敗（無料枠切れを含む）では、そこで打ち切って失敗を記録し、材料は消さずに残す。
 * 枠切れならその後の人も必ず失敗するので、同じ失敗を人数分積み上げない。材料が残るので次の収集でやり直せる。
 * 注意: この失敗で収集そのものを止めない。LLMが使えない日に、配信の記録（視聴者数・フォロワー数）まで
 * 止まってしまうのを避けるためである。黙って飛ばすのではなく collection_failures に残し、管理画面から気づけるようにする。
 */
const summarizeViewers = async (db: Database, ai: TextGenerator, now: number): Promise<void> => {
  const targets = await listSummaryTargets(db, SUMMARY_BATCH_SIZE)
  for (const target of targets) {
    const viewer = await readViewer(db, target.userId)
    // 記録を消された人（本人から求められて削除した場合）の材料は、LLMを呼ばずに捨てる
    if (viewer === null) {
      await deleteStreamChatMessages(db, target.userId)
      continue
    }

    const messages = await readViewerMessages(db, target.userId, SUMMARY_MESSAGE_LIMIT)
    let summary: string
    try {
      summary = await generateViewerSummary(ai, { viewer, messages })
    } catch (error) {
      await recordFailure(db, 'viewer-summary-failed', error instanceof Error ? error.message : String(error), now)
      return
    }

    await updateViewerSummary(db, target.userId, summary, now)
    await deleteStreamChatMessages(db, target.userId)
  }
}

const collect = async ({ db, store, twitch, ai, broadcasterId, now }: CollectStatsOptions): Promise<void> => {
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
  await deleteOldStreamChatMessages(db, now - STREAM_CHAT_RETENTION_MS)

  // 人物像づくりは、配信の記録を残したあとに行う（LLMが使えなくても記録は残す）
  await summarizeViewers(db, ai, now)
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
