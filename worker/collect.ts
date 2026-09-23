/**
 * cron による配信の記録の収集
 *
 * Twitchには過去の視聴者数の推移を返すAPIがなく、取れるのは「いま」の値だけなので、定期的に取得してデータベースへ貯める。
 * 1回の収集で、配信の状態（配信中ならセッションの開始・継続と視聴者数、配信していなければセッションの終了）と、フォロワー数を記録し、
 * あわせて終わった配信の発言から視聴者の人物像を作り、古くなった記録（first_chatters・stream_chat_messages・transcripts）を消す。
 *
 * 注意: トークンが無い・更新できない・Twitchが失敗を返したときは、黙って飛ばさない。
 * 失敗をデータベース（collection_failures）に記録したうえでエラーを投げ、cron の実行も失敗として残す（Fail-Fast）。
 */
import type { TextGenerator } from './ai-chat'
import { deleteOldFirstChatters } from './chat-store'
import type { Database } from './database'
import { deleteOldStreamChatMessages, deleteStreamChatMessages, listSummaryTargets, readSessionChatSince, readViewerMessages } from './stream-chat-store'
import { readStreamSummary, saveStreamSummary } from './stream-summary-store'
import { generateStreamSummary } from './stream-summary'
import { deleteOldTranscripts, readTranscriptsSince } from './transcript-store'
import { ViewerSummaryContentError, generateViewerSummary } from './viewer-summary'
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
 * 1回のあらすじづくりで読む、配信者の発話（文字起こし）の件数の上限。
 *
 * あらすじは前回のあらすじに積み上げる形なので、1回で読むのは前回からの5分ぶんだけでよい。
 * それでも上限を置くのは、押し込みが溜まっていた場合（中継ページのやり直し）に1回の入力が
 * 膨らむのを防ぐためである。超えたぶんは次の収集へ回る。
 */
const STREAM_SUMMARY_TRANSCRIPT_LIMIT = 100

/**
 * 1回のあらすじづくりで読む、視聴者の発言の件数の上限。
 *
 * 発言は文字起こしより短く、盛り上がると一気に増えるので、同じ上限でも入力への効き方が違う。
 * それでも同じ数にしておくのは、どちらか一方だけで材料が埋まらないようにするためである。
 */
const STREAM_SUMMARY_CHAT_LIMIT = 100

/**
 * 人物像の材料（配信中のチャット）を残しておく期間（ミリ秒）。
 *
 * ふつうは人物像を作った時点で消える（deleteStreamChatMessages）ので、ここで消えるのは、
 * LLMを呼べないまま残った材料（無料枠を使い切った日など）だけである。
 * 配信中の発言まで巻き添えにしないよう、1回の配信より十分に長くとる。
 */
export const STREAM_CHAT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 配信中の文字起こしを残しておく期間（ミリ秒）。
 *
 * 文字起こしはあらすじ（issue #65）の材料として配信中だけ持つもので、終わった配信のぶんを残しておく
 * 意味はない。それでも1日ぶん残すのは、配信の直後にあらすじを読み返せるようにするためである。
 * 配信中の区切りのぶんは、この期間を過ぎても消さない（deleteOldTranscripts を参照）。
 */
export const TRANSCRIPT_RETENTION_MS = 24 * 60 * 60 * 1000

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
 * いま進んでいる配信の「これまでのあらすじ」を作り直す（issue #65）。
 *
 * 材料は、前回のあらすじと、そのあとに届いた配信者の発話（transcripts）・視聴者の発言
 * （stream_chat_messages）である。毎回ゼロから作り直さず積み上げるので、長い配信でも1回あたりの
 * 入力が一定に保たれる（worker/stream-summary.ts）。
 *
 * 注意: 新しい材料が1件も無ければLLMを呼ばない。配信していても喋りも発言もない時間帯はあるので、
 * 5分おきに無駄な Neurons を使わないためである（alert-state.ts の「要らなければ読まない」と同じ考え方）。
 * 注意: 失敗しても収集そのものを止めず、前回のあらすじも消さない。あらすじはチャットのコマンドが
 * 読み出して返すものなので、作り直せなかったときに前回のものが残っていれば、コマンドは無応答にならない。
 * 失敗を黙って飲み込まず collection_failures に残すのは、人物像づくりと同じである。
 *
 * @param sessionId いま進んでいる配信の区切り。Twitchが返した配信のIDがそのまま区切りのIDになる
 *   （stats-store.ts の recordLiveStream）ので、配信中かどうかを引き直さずに済む
 */
const summarizeStream = async (db: Database, ai: TextGenerator, sessionId: string, now: number): Promise<void> => {
  const previous = await readStreamSummary(db, sessionId)
  // まだ一度も作っていなければ、どの行よりも前を指す目印（空文字の組）から読む
  const transcriptsFrom = previous?.transcriptsUntil ?? { at: '', messageId: '' }
  const chatFrom = previous?.chatUntil ?? { at: '', messageId: '' }
  const transcripts = await readTranscriptsSince(db, sessionId, transcriptsFrom, STREAM_SUMMARY_TRANSCRIPT_LIMIT)
  const chats = await readSessionChatSince(db, sessionId, chatFrom, STREAM_SUMMARY_CHAT_LIMIT)
  if (transcripts.length === 0 && chats.length === 0) return

  let summary: string
  try {
    summary = await generateStreamSummary(ai, {
      previous: previous?.summary ?? '',
      transcripts: transcripts.map((line) => line.text),
      chats: chats.map((line) => line.text),
    })
  } catch (error) {
    // 返ってきた文そのものの問題（StreamSummaryContentError）も、LLMを呼べなかった失敗も同じ扱いでよい。
    // 対象が1件しかないので、人物像づくりのような「その人を飛ばして次の人へ進む」という分かれ道がない
    await recordFailure(db, 'stream-summary-failed', error instanceof Error ? error.message : String(error), now)
    return
  }

  // 読めた材料の最後の行を「どこまで材料にしたか」の目印として記録する。件数の上限で切れた残りは、
  // 読む順（日時・メッセージIDの順）でこの目印より後ろにあるので、次の収集で読まれる（取りこぼしにはならない）
  const 最後の発話 = transcripts.at(-1)
  const 最後の発言 = chats.at(-1)
  await saveStreamSummary(
    db,
    {
      sessionId,
      summary,
      transcriptsUntil: 最後の発話 ? { at: 最後の発話.at, messageId: 最後の発話.messageId } : transcriptsFrom,
      chatUntil: 最後の発言 ? { at: 最後の発言.at, messageId: 最後の発言.messageId } : chatFrom,
    },
    now,
  )
}

/**
 * 終わった配信の発言から、視聴者の人物像を作る。
 *
 * 材料が残っていること自体が「まだ作っていない」という印なので、作り終えた人のぶんはその場で消す
 * （stream-chat-store.ts）。1回に処理する人数を SUMMARY_BATCH_SIZE までに抑え、残りは次の収集に回す。
 *
 * 注意: LLMを呼べなかった失敗（無料枠切れ・通信の失敗）では、そこで打ち切って失敗を記録し、材料は消さずに残す。
 * 枠切れならその後の人も必ず失敗するので、同じ失敗を人数分積み上げない。材料が残るので次の収集でやり直せる。
 * 注意: 返ってきた人物像そのものに問題があった失敗（ViewerSummaryContentError）では、その人だけを飛ばして次へ進む。
 * その人の材料からは何度やっても同じ結果になりやすいので、打ち切るとその人が列の先頭（発言の多い順）を塞ぎ続け、
 * ほかの人の人物像がいつまでも作られない。飛ばした人の材料は残るので、次の収集でやり直され、
 * それでも作れなければ保持期間（STREAM_CHAT_RETENTION_MS）で消える。
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
      if (error instanceof ViewerSummaryContentError) continue
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
  await deleteOldTranscripts(db, now - TRANSCRIPT_RETENTION_MS)

  // あらすじづくりと人物像づくりは、配信の記録を残したあとに行う（LLMが使えなくても記録は残す）。
  // あらすじを先にするのは、配信中の視聴者がコマンドで読むものであり、待たせる相手がいるためである
  // （人物像は終わった配信のぶんを作るので、1回遅れても誰も困らない）。無料枠は両者で分け合う
  if (stream) await summarizeStream(db, ai, stream.id, now)
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
