/**
 * コメントビューアーに流す1件への変換
 *
 * コメントビューアー（/comments/）は、配信中のチャットの発言と、サブスク・ギフト・レイド・チャンネルポイントの
 * 引き換え・フォローといった出来事、モデレーターによる発言の消去を、届いた順に1本の流れとして並べる。
 * ここは EventSub の通知の中身（event）を、その流れの1件（FeedItem）に直すだけを受け持つ。通信を伴わない。
 *
 * 流す通知の選び方:
 * - サブスク・ギフト・レイドは channel.chat.notification から読む（1本で揃い、ギフトや添えられた発言も届くため）。
 *   同じ出来事を別に知らせる channel.subscribe・channel.subscription.message・channel.raid は流さない（二重に並ぶため）
 * - ビッツは発言そのもの（channel.chat.message の cheer）から読む
 * - 発言の削除・BAN/タイムアウトによる消去・全消去も流し、画面の側で該当する発言に印を付ける
 * - 発言の既読・未読の付け替え（read）は Twitch の通知ではなく、コメントビューアーから付け替えたときに
 *   comment-routes.ts が流す（開いているほかの画面にも同じ印を付け、開き直したときも履歴から印を戻すため）
 *
 * 注意: 画面は届いた形をそのまま信じず、src/comments/feed.ts で形を確かめる。形を変えるときは両方を直す。
 * 注意: 流す種類の通知で中身が欠けていれば、黙って捨てずに投げる（Fail-Fast）。呼び出し側は失敗として記録する。
 */
import { readChatMessage } from './chat-command'
import type { CommentReadMarker } from './comment-read-store'

/** 発言した人・出来事を起こした人 */
export interface FeedUser {
  id: string
  login: string
  /** 表示名（本人が変えられる） */
  name: string
}

/** 付いているバッジ（画像は画面が /api/chat/badges から引く） */
export interface FeedBadge {
  setId: string
  versionId: string
}

/** 本文の断片。エモートなら画像のID、そうでなければ null */
export interface FeedFragment {
  text: string
  emoteId: string | null
}

/**
 * チャットのお知らせの中身。
 *
 * 階層（tier）は Twitch の値（'1000'・'2000'・'3000'）のまま持ち、表示のときに読み替える。
 * 個別に扱わない種類（ビッツのバッジ・チャリティなど）は捨てず、Twitch の説明文（英語）をそのまま持つ。
 */
export type FeedNotice =
  | { type: 'sub'; tier: string; prime: boolean }
  | { type: 'resub'; tier: string; prime: boolean; months: number }
  | { type: 'subGift'; tier: string; recipient: string }
  | { type: 'communityGift'; tier: string; count: number }
  | { type: 'raid'; viewers: number }
  | { type: 'announcement' }
  | { type: 'other'; systemMessage: string }

/** どの1件にも付く目印 */
export interface FeedStamp {
  /** 通知のメッセージID（Twitch-Eventsub-Message-Id）。再送で同じ1件が2度届いたとき、画面はこれで見分ける */
  id: string
  /** 通知が届いた時刻（ミリ秒） */
  at: number
}

/** コメントビューアーに流す1件 */
export type FeedItem = FeedStamp &
  (
    | {
        kind: 'chat'
        /** 発言のID（削除の印や注目コメントの選択に使う） */
        messageId: string
        user: FeedUser
        /** 名前の色（#rrggbb）。設定していない人は null */
        color: string | null
        badges: FeedBadge[]
        fragments: FeedFragment[]
        /** 贈ったビッツ数。贈っていなければ null */
        bits: number | null
        /** 返信なら返信先の名前と本文 */
        reply: { name: string; text: string } | null
      }
    | {
        kind: 'notice'
        messageId: string
        /** 匿名のギフトなら null */
        user: FeedUser | null
        color: string | null
        badges: FeedBadge[]
        /** 添えられた発言（無ければ空） */
        fragments: FeedFragment[]
        notice: FeedNotice
      }
    | { kind: 'redemption'; user: FeedUser; reward: string; cost: number; input: string }
    | { kind: 'follow'; user: FeedUser }
    | { kind: 'delete'; messageId: string }
    | { kind: 'clearUser'; userId: string }
    | { kind: 'clear' }
    | {
        kind: 'read'
        /** 付け替えた発言のID */
        messageId: string
        /** 既読にしたなら true、未読に戻したなら false */
        read: boolean
        /** 付け替えたのは誰か */
        by: CommentReadMarker
      }
  )

export const CHAT_NOTIFICATION = 'channel.chat.notification'
export const CHAT_MESSAGE_DELETE = 'channel.chat.message_delete'
export const CHAT_CLEAR_USER_MESSAGES = 'channel.chat.clear_user_messages'
export const CHAT_CLEAR = 'channel.chat.clear'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** 中身から文字列を取り出す。無ければ、どの通知のどの項目かを添えて投げる */
const readString = (record: Record<string, unknown>, key: string, where: string): string => {
  const value = record[key]
  if (typeof value !== 'string') throw new Error(`${where} の通知に ${key} がありません`)
  return value
}

const readNumber = (record: Record<string, unknown>, key: string, where: string): number => {
  const value = record[key]
  if (typeof value !== 'number') throw new Error(`${where} の通知に ${key} がありません`)
  return value
}

/** 中身の入れ子を取り出す。無ければ投げる */
const readRecord = (record: Record<string, unknown>, key: string, where: string): Record<string, unknown> => {
  const value = record[key]
  if (!isRecord(value)) throw new Error(`${where} の通知に ${key} がありません`)
  return value
}

/** 名前の色。設定していない人は空文字で届くので null にする */
const readColor = (event: Record<string, unknown>): string | null => (typeof event.color === 'string' && event.color !== '' ? event.color : null)

/** バッジ（{ set_id, id } の配列）。付いていない発言では無い・空で届くので、欠けていてもエラーにしない */
const readBadges = (badges: unknown): FeedBadge[] =>
  Array.isArray(badges)
    ? badges.flatMap((badge: unknown) =>
        isRecord(badge) && typeof badge.set_id === 'string' && typeof badge.id === 'string' ? [{ setId: badge.set_id, versionId: badge.id }] : [],
      )
    : []

/** 本文（message）の断片。エモートの断片だけ画像のIDを持たせる */
const readFragments = (message: unknown, where: string): FeedFragment[] => {
  const fragments = isRecord(message) ? message.fragments : undefined
  if (!Array.isArray(fragments)) throw new Error(`${where} の通知に message.fragments がありません`)
  return fragments.map((fragment: unknown) => {
    if (!isRecord(fragment) || typeof fragment.text !== 'string') throw new Error(`${where} の通知の message.fragments に text の無いものがあります`)
    const emoteId = fragment.type === 'emote' && isRecord(fragment.emote) && typeof fragment.emote.id === 'string' ? fragment.emote.id : null
    return { text: fragment.text, emoteId }
  })
}

/** user_id・user_login・user_name（または接頭辞つき）から人を取り出す */
const readUser = (event: Record<string, unknown>, prefix: string, where: string): FeedUser => ({
  id: readString(event, `${prefix}_id`, where),
  login: readString(event, `${prefix}_login`, where),
  name: readString(event, `${prefix}_name`, where),
})

const toChat = (event: unknown, stamp: FeedStamp): FeedItem => {
  const where = 'channel.chat.message'
  // 発言者と本文の読み取りはコマンドの判定と同じものを使う（同じ通知を2か所で読み解かない）
  if (!isRecord(event)) throw new Error(`${where} の通知に event がありません`)
  const message = readChatMessage(event)
  const cheer = event.cheer
  const reply = event.reply
  return {
    kind: 'chat',
    ...stamp,
    messageId: message.messageId,
    user: { id: message.chatterUserId, login: message.chatterUserLogin, name: message.chatterUserName },
    color: readColor(event),
    badges: readBadges(event.badges),
    fragments: readFragments(event.message, where),
    bits: isRecord(cheer) ? readNumber(cheer, 'bits', `${where} の cheer`) : null,
    reply: isRecord(reply)
      ? { name: readString(reply, 'parent_user_name', `${where} の reply`), text: readString(reply, 'parent_message_body', `${where} の reply`) }
      : null,
  }
}

/** お知らせの種類ごとの中身を読む。種類に対応する中身が欠けていれば投げる */
const readNotice = (event: Record<string, unknown>): FeedNotice => {
  const where = CHAT_NOTIFICATION
  const type = readString(event, 'notice_type', where)
  switch (type) {
    case 'sub': {
      const sub = readRecord(event, 'sub', where)
      return { type: 'sub', tier: readString(sub, 'sub_tier', where), prime: sub.is_prime === true }
    }
    case 'resub': {
      const resub = readRecord(event, 'resub', where)
      return { type: 'resub', tier: readString(resub, 'sub_tier', where), prime: resub.is_prime === true, months: readNumber(resub, 'cumulative_months', where) }
    }
    case 'sub_gift': {
      const gift = readRecord(event, 'sub_gift', where)
      return { type: 'subGift', tier: readString(gift, 'sub_tier', where), recipient: readString(gift, 'recipient_user_name', where) }
    }
    case 'community_sub_gift': {
      const gift = readRecord(event, 'community_sub_gift', where)
      return { type: 'communityGift', tier: readString(gift, 'sub_tier', where), count: readNumber(gift, 'total', where) }
    }
    case 'raid':
      return { type: 'raid', viewers: readNumber(readRecord(event, 'raid', where), 'viewer_count', where) }
    case 'announcement':
      return { type: 'announcement' }
    default:
      return { type: 'other', systemMessage: readString(event, 'system_message', where) }
  }
}

const toNotice = (event: Record<string, unknown>, stamp: FeedStamp): FeedItem => {
  const where = CHAT_NOTIFICATION
  return {
    kind: 'notice',
    ...stamp,
    messageId: readString(event, 'message_id', where),
    // 匿名のギフトでは贈った人が伏せられる
    user: event.chatter_is_anonymous === true ? null : readUser(event, 'chatter_user', where),
    color: readColor(event),
    badges: readBadges(event.badges),
    fragments: readFragments(event.message, where),
    notice: readNotice(event),
  }
}

/**
 * 通知の中身を、コメントビューアーに流す1件に直す。
 *
 * @param subscriptionType 通知の種類（subscription.type）
 * @param event 通知の中身（event）
 * @param stamp 通知のメッセージIDと届いた時刻
 * @returns 流さない種類の通知なら null
 * @throws Error 流す種類の通知で、必要な項目が揃っていない
 */
export const toFeedItem = (subscriptionType: string, event: unknown, stamp: FeedStamp): FeedItem | null => {
  switch (subscriptionType) {
    case 'channel.chat.message':
      return toChat(event, stamp)
    case CHAT_NOTIFICATION:
      if (!isRecord(event)) throw new Error(`${subscriptionType} の通知に event がありません`)
      return toNotice(event, stamp)
    case 'channel.channel_points_custom_reward_redemption.add': {
      if (!isRecord(event)) throw new Error(`${subscriptionType} の通知に event がありません`)
      const reward = readRecord(event, 'reward', subscriptionType)
      return {
        kind: 'redemption',
        ...stamp,
        user: readUser(event, 'user', subscriptionType),
        reward: readString(reward, 'title', subscriptionType),
        cost: readNumber(reward, 'cost', subscriptionType),
        input: readString(event, 'user_input', subscriptionType),
      }
    }
    case 'channel.follow':
      if (!isRecord(event)) throw new Error(`${subscriptionType} の通知に event がありません`)
      return { kind: 'follow', ...stamp, user: readUser(event, 'user', subscriptionType) }
    case CHAT_MESSAGE_DELETE:
      if (!isRecord(event)) throw new Error(`${subscriptionType} の通知に event がありません`)
      return { kind: 'delete', ...stamp, messageId: readString(event, 'message_id', subscriptionType) }
    case CHAT_CLEAR_USER_MESSAGES:
      if (!isRecord(event)) throw new Error(`${subscriptionType} の通知に event がありません`)
      return { kind: 'clearUser', ...stamp, userId: readString(event, 'target_user_id', subscriptionType) }
    case CHAT_CLEAR:
      return { kind: 'clear', ...stamp }
    default:
      return null
  }
}
