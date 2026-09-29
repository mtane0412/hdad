/**
 * 配信者の発話からのコメントへの反応の判定
 *
 * 配信者がコメントに口頭で反応したら、そのコメントを既読にする（issue #147）。確定した発話を受け取るたびに
 * （worker/overlay-routes.ts の postTranscript）、直前の数文の発話と、まだ一度も付け替えていない視聴者の発言を
 * Jev（worker/jev.ts）に渡し、発言ごとに「この発話はその発言への反応か」を Noul（yes の確率）で判定させる。
 * しきい値（REACTION_THRESHOLD）以上の発言を Jev が付けた既読として記録し、コメントビューアーへ知らせる。
 *
 * 判定の作りは、実際に Jev を呼んで確かめた形に揃えてある（issue #147）。
 * - 指示文は日本語にする（英語より判定が正しかった）
 * - 質問の中に視聴者の名前と発言の本文を書く（質問の名前はモデルに伝わらないため）
 * - 1回の注文に、未読の発言1件につき Noul を1問入れる（同じ注文の質問は並列に評価されるので、件数を増やしても待つ時間はほぼ変わらない）
 *
 * 注意: 誤って既読にする害のほうが、見逃す害より大きい（反応し忘れを隠してしまうため）。しきい値は高めにとる。
 * 注意: 未読の発言が1件も無ければ Jev を呼ばない（docs/principles.md の8「新しい材料が無ければ呼ばない」）。
 * 呼ぶ回数は視聴者の発言数ではなく配信者の発話数で決まる。
 * 注意: 配信者が手で既読にした・未読に戻した発言は候補にしない（comment-read-store.ts の readUnreadChats）。
 * 判定のあいだに手で付け替えられた発言も上書きしない（markReadByJev）。
 * 注意: Jev の失敗は投げる。呼び出し側が失敗として記録し、発話の受け取りそのものは止めない。
 */
import { pushFeedItem, type CommentChannelNamespace } from './comment-channel'
import { markReadByJev, readUnreadChats, type UnreadChat } from './comment-read-store'
import type { Database } from './database'
import type { JevClient, JevRequest, NoulQuestion } from './jev'
import { readLatestTranscripts } from './transcript-store'

/**
 * 反応したとみなす確率の下限。
 *
 * 手で作った24件の場面で確かめたところ、0.8 では反応していない発言を既読にした誤りは0件だった
 * （0.5 より見逃しは増える）。誤って既読にする害のほうが大きいので、この値から始める。
 */
export const REACTION_THRESHOLD = 0.8

/**
 * 候補にする発言の古さの上限（ミリ秒）。
 *
 * 配信者が口頭で反応するのは直近の発言なので、これより前の発言は候補にしない（毎回の注文を小さく保つため）。
 */
const CANDIDATE_WINDOW_MS = 10 * 60 * 1000

/** 1回の注文に入れる発言の上限。チャットが速い配信でも、注文が際限なく大きくならないようにする */
const MAX_CANDIDATES = 20

/** 材料にする直前の発話の数。返事は「えーっと」「〇〇って聞かれたんだけど」のように複数の文にまたがるため */
const TRANSCRIPT_CONTEXT = 3

/** 「その発言への反応か」の境目。反応していないのに既読にしないよう、偶然話題が重なる独り言を「いいえ」側に書く */
const REACTION_CRITERIA: NoulQuestion['criteria'] = {
  true: '配信者がそのチャットを読んだうえで、返事・お礼・答え・相づち・笑いなどで応じている（名前を呼ばない返事や、複数人へのまとめての挨拶も含む）',
  false: 'そのチャットに応じていない。話題が偶然重なっているだけの独り言や、別のチャットへの反応はこちら',
}

/** 発言の並びの何番目かを、質問の名前にする */
const questionName = (index: number): string => `c${index}`

/**
 * Jev へ渡す注文を組み立てる。
 *
 * @param transcript 直前の発話（古い順）
 * @param chats まだ一度も付け替えていない視聴者の発言（古い順）。1件につき1問にする
 */
export const buildReactionRequest = (transcript: readonly string[], chats: readonly UnreadChat[]): JevRequest<Record<string, NoulQuestion>> => ({
  state: { transcript, recent_chat: chats.map(({ name, text }) => ({ user: name, text })) },
  questions: Object.fromEntries(
    chats.map(({ name, text }, index) => [
      questionName(index),
      {
        type: 'noul',
        instructions: `配信者の直近の発話（\`transcript\`。古い順）は、視聴者「${name}」のチャット「${text}」に対する反応ですか。`,
        criteria: REACTION_CRITERIA,
      },
    ]),
  ),
})

/** 判定に要るもの */
export interface CommentReactionOptions {
  /** 発言・発話・既読を読み書きするデータベース（D1） */
  db: Database
  jev: JevClient
  /** 既読にしたことを知らせる、コメントビューアーの配送先 */
  comments: CommentChannelNamespace
  /** 配信者のユーザーID。配信者自身の発言は候補にしない */
  broadcasterId: string
  /** 現在時刻（ミリ秒） */
  now: number
}

/**
 * 直前の発話がどの未読の発言への反応かを判定し、反応したものを既読にする。
 *
 * @throws Error Jev が失敗した・記録や知らせに失敗した場合（呼び出し側が失敗として記録する）
 */
export const judgeCommentReactions = async ({ db, jev, comments, broadcasterId, now }: CommentReactionOptions): Promise<void> => {
  const chats = await readUnreadChats(db, { broadcasterId, since: now - CANDIDATE_WINDOW_MS, limit: MAX_CANDIDATES })
  if (chats.length === 0) return

  const transcript = await readLatestTranscripts(db, TRANSCRIPT_CONTEXT)
  const answers = await jev.decide('commentReaction', buildReactionRequest(transcript, chats))

  for (const [index, chat] of chats.entries()) {
    const probability = answers[questionName(index)]
    if (probability === undefined || probability < REACTION_THRESHOLD) continue
    // 判定のあいだに配信者が手で付け替えていたら記録されないので、そのときは知らせない
    if (!(await markReadByJev(db, chat.messageId, now))) continue
    await pushFeedItem(comments, { kind: 'read', id: crypto.randomUUID(), at: now, messageId: chat.messageId, read: true, by: 'jev' })
  }
}
