/**
 * コメントビューアーの流れ（届いた1件の読み取りと、並びの組み立て）
 *
 * Worker の配送先（worker/comment-channel.ts）は、つないだ直後に直近の履歴（backlog）を、そのあとは
 * 1件ずつ（item）を送ってくる。ここはその文字列を読み取り、画面に並べる順の一覧へ積むだけを受け持つ。
 * 通信もDOMも持たないので、画面から切り離してテストする。
 *
 * 並べ方の決まり:
 * - 同じ1件（通知のメッセージIDが同じもの）は二度当てはめない。Twitch の再送や、つなぎ直したときの履歴で同じものが届くため。
 *   モデレーターの操作も同じで、つなぎ直しで古い全消去がまた届いたときに、そのあとに届いた発言へ印を付けてしまわないようにする
 * - モデレーターの操作（削除・BAN/タイムアウトによる消去・全消去）は行として並べず、該当する発言に印を付ける。
 *   並びからは消さないのは、何が消されたのかを配信者が見られるようにするためである
 * - 並べるのは直近の上限（MAX_ENTRIES）まで。配信の最初から全部を画面に持ち続けない
 * - 初めての発言への挨拶の付け替え（greeting）も行として並べず、該当する発言に挨拶した印を付ける（戻したら外す）。
 *   付け替えは配送先の履歴にも届いた順に残るので、開き直したときも履歴を当てはめるだけで最後の状態に戻る
 *
 * 挨拶が要るのは、その配信で初めての発言（firstOfStream。Worker が判定して付ける）のうち、まだ挨拶しておらず
 * モデレーターに消されていないものだけである（needsGreeting）。画面はこれを目立たせ、上部に一覧にする（pendingGreetings）。
 *
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、形は worker/comment-feed.ts の FeedItem と
 * 合わせてここにも書き、届くたびに確かめる。想定と違う形はエラーにする（Workerとの食い違いに気づけるように）。
 */
import { isRecord } from '../core/api'
import type { FocusPick } from '../focus/api'

export interface FeedUser {
  id: string
  login: string
  name: string
}

export interface FeedBadge {
  setId: string
  versionId: string
}

/** 本文の断片。エモートなら画像のID、そうでなければ null */
export interface FeedFragment {
  text: string
  emoteId: string | null
}

/** チャットのお知らせの中身。worker/comment-feed.ts の FeedNotice と合わせる */
export type FeedNotice =
  | { type: 'sub'; tier: string; prime: boolean }
  | { type: 'resub'; tier: string; prime: boolean; months: number }
  | { type: 'subGift'; tier: string; recipient: string }
  | { type: 'communityGift'; tier: string; count: number }
  | { type: 'raid'; viewers: number }
  | { type: 'announcement' }
  | { type: 'other'; systemMessage: string }

interface FeedStamp {
  /** 通知のメッセージID。同じ1件かどうかをこれで見分ける */
  id: string
  /** 届いた時刻（ミリ秒） */
  at: number
}

export type ChatItem = FeedStamp & {
  kind: 'chat'
  messageId: string
  user: FeedUser
  color: string | null
  badges: FeedBadge[]
  fragments: FeedFragment[]
  bits: number | null
  reply: { name: string; text: string } | null
  /** その配信で初めての発言か（挨拶の相手か）。配信者自身と bot の発言では false */
  firstOfStream: boolean
}

export type NoticeItem = FeedStamp & {
  kind: 'notice'
  messageId: string
  /** 匿名のギフトなら null */
  user: FeedUser | null
  color: string | null
  badges: FeedBadge[]
  fragments: FeedFragment[]
  notice: FeedNotice
}

type RedemptionItem = FeedStamp & { kind: 'redemption'; user: FeedUser; reward: string; cost: number; input: string }
type FollowItem = FeedStamp & { kind: 'follow'; user: FeedUser }
type DeleteItem = FeedStamp & { kind: 'delete'; messageId: string }
type ClearUserItem = FeedStamp & { kind: 'clearUser'; userId: string }
type ClearItem = FeedStamp & { kind: 'clear' }

/** 初めての発言への挨拶の付け替え。greeted は挨拶したなら true、挨拶していない状態に戻したなら false */
type GreetingItem = FeedStamp & { kind: 'greeting'; messageId: string; greeted: boolean }

/** 出来事（発言でない行）。1行の文にして並べる */
export type EventItem = NoticeItem | RedemptionItem | FollowItem

/** 行として並べるもの */
export type RowItem = ChatItem | EventItem

/** 届く1件。worker/comment-feed.ts の FeedItem と合わせる */
export type FeedItem = RowItem | DeleteItem | ClearUserItem | ClearItem | GreetingItem

/** 届く文字列の中身 */
export type FeedMessage = { type: 'backlog'; items: FeedItem[] } | { type: 'item'; item: FeedItem }

/** 並びの1行 */
export interface FeedEntry {
  item: RowItem
  /** モデレーターの操作で消された発言なら true */
  removed: boolean
  /** 挨拶したか（その配信で初めての発言にだけ意味を持つ） */
  greeted: boolean
}

export interface Feed {
  /** 古い順 */
  entries: readonly FeedEntry[]
  /**
   * すでに当てはめた通知のメッセージID（古い順）。行にならないモデレーターの操作のぶんも持つので、並びとは別にする
   */
  applied: readonly string[]
}

export const EMPTY_FEED: Feed = { entries: [], applied: [] }

/**
 * 画面に並べておく件数の上限。
 *
 * 配信中に見返すのは直近の数十分で足りる。多すぎると並びを描き直すたびに重くなる。
 */
export const MAX_ENTRIES = 500

/**
 * 覚えておく当てはめ済みのメッセージIDの件数。
 *
 * 同じ通知がまた届くのは、Twitch の再送（数分以内）と、つなぎ直したときの配送先の履歴（直近400件）だけなので、
 * 並べる件数の倍を覚えておけば足りる。配信のあいだ際限なく増やさないために区切る。
 */
const MAX_APPLIED_IDS = MAX_ENTRIES * 2

const isString = (value: unknown): value is string => typeof value === 'string'
const isNumber = (value: unknown): value is number => typeof value === 'number'
const isNullableString = (value: unknown): value is string | null => value === null || isString(value)

const isUser = (value: unknown): value is FeedUser => isRecord(value) && isString(value.id) && isString(value.login) && isString(value.name)

const isBadges = (value: unknown): value is FeedBadge[] =>
  Array.isArray(value) && value.every((badge: unknown) => isRecord(badge) && isString(badge.setId) && isString(badge.versionId))

const isFragments = (value: unknown): value is FeedFragment[] =>
  Array.isArray(value) && value.every((fragment: unknown) => isRecord(fragment) && isString(fragment.text) && isNullableString(fragment.emoteId))

const isNotice = (value: unknown): value is FeedNotice => {
  if (!isRecord(value)) return false
  switch (value.type) {
    case 'sub':
      return isString(value.tier) && typeof value.prime === 'boolean'
    case 'resub':
      return isString(value.tier) && typeof value.prime === 'boolean' && isNumber(value.months)
    case 'subGift':
      return isString(value.tier) && isString(value.recipient)
    case 'communityGift':
      return isString(value.tier) && isNumber(value.count)
    case 'raid':
      return isNumber(value.viewers)
    case 'announcement':
      return true
    case 'other':
      return isString(value.systemMessage)
    default:
      return false
  }
}

const isReply = (value: unknown): value is ChatItem['reply'] => value === null || (isRecord(value) && isString(value.name) && isString(value.text))

/** 届いた1件が、種類ごとに決めた形をしているか */
const isFeedItem = (value: unknown): value is FeedItem => {
  if (!isRecord(value) || !isString(value.id) || !isNumber(value.at)) return false
  switch (value.kind) {
    case 'chat':
      return (
        isString(value.messageId) &&
        isUser(value.user) &&
        isNullableString(value.color) &&
        isBadges(value.badges) &&
        isFragments(value.fragments) &&
        (value.bits === null || isNumber(value.bits)) &&
        isReply(value.reply) &&
        typeof value.firstOfStream === 'boolean'
      )
    case 'notice':
      return (
        isString(value.messageId) &&
        (value.user === null || isUser(value.user)) &&
        isNullableString(value.color) &&
        isBadges(value.badges) &&
        isFragments(value.fragments) &&
        isNotice(value.notice)
      )
    case 'redemption':
      return isUser(value.user) && isString(value.reward) && isNumber(value.cost) && isString(value.input)
    case 'follow':
      return isUser(value.user)
    case 'delete':
      return isString(value.messageId)
    case 'clearUser':
      return isString(value.userId)
    case 'clear':
      return true
    case 'greeting':
      return isString(value.messageId) && typeof value.greeted === 'boolean'
    default:
      return false
  }
}

/**
 * 配送先から届いた文字列を読む。
 *
 * @throws Error JSONとして読めない・想定した形でない
 */
export const parseFeedMessage = (text: string): FeedMessage => {
  const body: unknown = JSON.parse(text)
  if (isRecord(body) && body.type === 'backlog' && Array.isArray(body.items)) {
    const items: unknown[] = body.items
    const broken = items.findIndex((item) => !isFeedItem(item))
    if (broken !== -1) throw new Error(`コメントビューアーの履歴の ${broken} 件目が想定した形ではありません`)
    return { type: 'backlog', items: items.filter(isFeedItem) }
  }
  if (isRecord(body) && body.type === 'item') {
    if (!isFeedItem(body.item)) throw new Error('コメントビューアーに届いた1件が想定した形ではありません')
    return { type: 'item', item: body.item }
  }
  throw new Error('コメントビューアーに届いたものが想定した形ではありません')
}

/** 発言を持つ行（消去の印を付ける相手）か */
const isMessageRow = (item: RowItem): item is ChatItem | NoticeItem => item.kind === 'chat' || item.kind === 'notice'

/** 1件を並びへ積む。モデレーターの操作なら、該当する行に印を付ける。すでに当てはめた1件なら何もしない */
const applyOne = (entries: FeedEntry[], applied: Set<string>, item: FeedItem): FeedEntry[] => {
  if (applied.has(item.id)) return entries
  applied.add(item.id)
  switch (item.kind) {
    case 'delete':
      return entries.map((entry) => (isMessageRow(entry.item) && entry.item.messageId === item.messageId ? { ...entry, removed: true } : entry))
    case 'clearUser':
      return entries.map((entry) => (isMessageRow(entry.item) && entry.item.user?.id === item.userId ? { ...entry, removed: true } : entry))
    case 'clear':
      return entries.map((entry) => (isMessageRow(entry.item) ? { ...entry, removed: true } : entry))
    case 'greeting':
      return entries.map((entry) => (entry.item.kind === 'chat' && entry.item.messageId === item.messageId ? { ...entry, greeted: item.greeted } : entry))
    default:
      return [...entries, { item, removed: false, greeted: false }]
  }
}

/** 届いた1件（または履歴）を並びへ積む。元の並びは書き換えない */
export const applyFeedItems = (feed: Feed, items: readonly FeedItem[]): Feed => {
  // Set は加えた順を保つので、古いものから落とすときにそのまま使える
  const applied = new Set(feed.applied)
  const entries = items.reduce<FeedEntry[]>((accumulated, item) => applyOne(accumulated, applied, item), [...feed.entries])
  return { entries: entries.slice(-MAX_ENTRIES), applied: [...applied].slice(-MAX_APPLIED_IDS) }
}

/** 挨拶が要る行か。その配信で初めての発言で、まだ挨拶しておらず、モデレーターに消されていないものだけ */
export const needsGreeting = (entry: FeedEntry): entry is FeedEntry & { item: ChatItem } =>
  entry.item.kind === 'chat' && entry.item.firstOfStream && !entry.greeted && !entry.removed

/** まだ挨拶していない初めての発言を、届いた順（古い順）に取り出す（画面の上部の一覧に使う） */
export const pendingGreetings = (entries: readonly FeedEntry[]): ChatItem[] => entries.filter(needsGreeting).map((entry) => entry.item)

/**
 * 発言を、注目コメントとして取り上げる1件に直す（PUT /api/admin/focus に送る形）。
 *
 * 注目コメントは本文を文字だけで映すので、エモートは名前の文字のままつなげる。
 */
export const toFocusPick = (item: ChatItem): FocusPick => ({
  messageId: item.messageId,
  login: item.user.login,
  displayName: item.user.name,
  text: item.fragments.map((fragment) => fragment.text).join(''),
})

/** サブスクの階層（Twitch の '1000' など）を、配信者が見慣れた呼び方にする */
const tierLabel = (tier: string, prime: boolean): string => (prime ? 'Prime' : `Tier ${tier.slice(0, 1)}`)

/** 出来事を起こした人の呼び方。匿名のギフトでは名前が伏せられる */
const nameOf = (user: FeedUser | null): string => (user === null ? '匿名の人' : `${user.name} さん`)

/** 出来事を1行の文にする */
export const describeEvent = (item: EventItem): string => {
  switch (item.kind) {
    case 'redemption':
      return `${nameOf(item.user)}が「${item.reward}」を引き換えました（${item.cost}pt）`
    case 'follow':
      return `${nameOf(item.user)}がフォローしました`
    case 'notice': {
      const who = nameOf(item.user)
      const { notice } = item
      switch (notice.type) {
        case 'sub':
          return `${who}がサブスクしました（${tierLabel(notice.tier, notice.prime)}）`
        case 'resub':
          return `${who}が${notice.months}か月目のサブスクを継続しました（${tierLabel(notice.tier, notice.prime)}）`
        case 'subGift':
          return `${who}が ${notice.recipient} さんにサブスクをギフトしました（${tierLabel(notice.tier, false)}）`
        case 'communityGift':
          return `${who}がサブスクを${notice.count}件ギフトしました（${tierLabel(notice.tier, false)}）`
        case 'raid':
          return `${who}が${notice.viewers}人でレイドしてきました`
        case 'announcement':
          return `${who}のアナウンス`
        case 'other':
          return notice.systemMessage
      }
    }
  }
}
