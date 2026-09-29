/**
 * コメントビューアーの流れ（feed.ts）のテスト
 *
 * Worker（worker/comment-channel.ts）から届いた文字列を読み取れること、並びへ積むときに
 * 再送された1件を二重に並べないこと、モデレーターの操作で消えた発言に印を付けること、
 * 既読・未読の付け替えを発言に当てはめること、しばらく未読のままの発言を見分けることを確かめる。
 */
import { describe, expect, it } from 'vitest'
import {
  applyFeedItems,
  describeEvent,
  EMPTY_FEED,
  isLongUnread,
  MAX_ENTRIES,
  needsReaction,
  parseFeedMessage,
  toFocusPick,
  UNREAD_HIGHLIGHT_MS,
  type ChatItem,
  type EventItem,
  type FeedEntry,
  type FeedItem,
} from './feed'

const 常連さん = { id: '777', login: 'jouren_san', name: '常連さん' }
const 初見さん = { id: '888', login: 'shoken_san', name: '初見さん' }

/** 視聴者の発言を1件作る */
const 発言 = (id: string, messageId: string, user = 常連さん, text = 'こんばんは'): FeedItem => ({
  kind: 'chat',
  id,
  at: Date.parse('2026-09-29T12:00:00Z'),
  messageId,
  user,
  color: '#FF4500',
  badges: [],
  fragments: [{ text, emoteId: null }],
  bits: null,
  reply: null,
})

const 目印 = (id: string) => ({ id, at: Date.parse('2026-09-29T12:01:00Z') })

describe('parseFeedMessage', () => {
  it('つないだ直後に届く履歴を読む', () => {
    const 履歴 = { type: 'backlog', items: [発言('通知1', '発言1')] }

    expect(parseFeedMessage(JSON.stringify(履歴))).toEqual(履歴)
  })

  it('1件ずつ届くものを読む', () => {
    const フォロー = { kind: 'follow', ...目印('通知2'), user: 初見さん }

    expect(parseFeedMessage(JSON.stringify({ type: 'item', item: フォロー }))).toEqual({ type: 'item', item: フォロー })
  })

  it('お知らせ・引き換え・削除の形も読む', () => {
    const 届くもの: FeedItem[] = [
      { kind: 'notice', ...目印('通知3'), messageId: 'お知らせ1', user: null, color: null, badges: [], fragments: [], notice: { type: 'communityGift', tier: '1000', count: 5 } },
      { kind: 'redemption', ...目印('通知4'), user: 常連さん, reward: '質問する', cost: 500, input: '好きな食べ物は？' },
      { kind: 'delete', ...目印('通知5'), messageId: '発言1' },
      { kind: 'clearUser', ...目印('通知6'), userId: '777' },
      { kind: 'clear', ...目印('通知7') },
      { kind: 'read', ...目印('通知10'), messageId: '発言1', read: true, by: 'manual' },
    ]

    expect(parseFeedMessage(JSON.stringify({ type: 'backlog', items: 届くもの }))).toEqual({ type: 'backlog', items: 届くもの })
  })

  it('JSONとして読めなければ、黙って捨てずにエラーにする', () => {
    expect(() => parseFeedMessage('こんばんは')).toThrow()
  })

  it('知らない種類・項目の欠けた1件はエラーにする（Workerとの食い違いに気づけるように）', () => {
    expect(() => parseFeedMessage(JSON.stringify({ type: 'item', item: { kind: 'hug', ...目印('通知8') } }))).toThrow()
    expect(() => parseFeedMessage(JSON.stringify({ type: 'item', item: { kind: 'follow', ...目印('通知9') } }))).toThrow()
  })
})

describe('applyFeedItems', () => {
  it('届いた順に並べる', () => {
    const feed = applyFeedItems(EMPTY_FEED, [発言('通知1', '発言1'), 発言('通知2', '発言2')])

    expect(feed.entries.map((entry) => entry.item.id)).toEqual(['通知1', '通知2'])
  })

  it('再送やつなぎ直しで同じ1件がまた届いても、二重に並べない', () => {
    const 一度目 = applyFeedItems(EMPTY_FEED, [発言('通知1', '発言1')])

    const 二度目 = applyFeedItems(一度目, [発言('通知1', '発言1'), 発言('通知2', '発言2')])

    expect(二度目.entries.map((entry) => entry.item.id)).toEqual(['通知1', '通知2'])
  })

  it('削除された発言には印を付け、並びからは消さない（何が消されたかを配信者が見られるように）', () => {
    const feed = applyFeedItems(EMPTY_FEED, [発言('通知1', '発言1'), 発言('通知2', '発言2'), { kind: 'delete', ...目印('通知3'), messageId: '発言1' }])

    expect(feed.entries.map((entry) => [entry.item.id, entry.removed])).toEqual([
      ['通知1', true],
      ['通知2', false],
    ])
  })

  it('BAN・タイムアウトでは、その人の発言すべてに印を付ける', () => {
    const feed = applyFeedItems(EMPTY_FEED, [
      発言('通知1', '発言1', 常連さん),
      発言('通知2', '発言2', 初見さん),
      発言('通知3', '発言3', 常連さん),
      { kind: 'clearUser', ...目印('通知4'), userId: 常連さん.id },
    ])

    expect(feed.entries.map((entry) => entry.removed)).toEqual([true, false, true])
  })

  it('BAN・タイムアウトでは、その人のお知らせ（継続サブスクに添えた発言など）にも印を付ける', () => {
    const 継続サブスク: FeedItem = {
      kind: 'notice',
      ...目印('通知1'),
      messageId: 'お知らせ1',
      user: 常連さん,
      color: null,
      badges: [],
      fragments: [{ text: '今月もよろしく', emoteId: null }],
      notice: { type: 'resub', tier: '1000', prime: false, months: 3 },
    }

    const feed = applyFeedItems(EMPTY_FEED, [継続サブスク, { kind: 'clearUser', ...目印('通知2'), userId: 常連さん.id }])

    expect(feed.entries.map((entry) => entry.removed)).toEqual([true])
  })

  it('全消去では、それまでの発言すべてに印を付ける', () => {
    const feed = applyFeedItems(EMPTY_FEED, [発言('通知1', '発言1'), { kind: 'clear', ...目印('通知2') }, 発言('通知3', '発言2')])

    expect(feed.entries.map((entry) => entry.removed)).toEqual([true, false])
  })

  it('つなぎ直しで同じ全消去がまた届いても、そのあとに届いた発言には印を付けない', () => {
    // 前提: 全消去のあとに発言2が届いて並んでいる。つなぎ直すと、配送先は全消去を含む履歴を送り直してくる
    const 全消去 = { kind: 'clear' as const, ...目印('通知2') }
    const 並び = applyFeedItems(EMPTY_FEED, [発言('通知1', '発言1'), 全消去, 発言('通知3', '発言2')])

    const つなぎ直した後 = applyFeedItems(並び, [発言('通知1', '発言1'), 全消去, 発言('通知3', '発言2')])

    expect(つなぎ直した後.entries.map((entry) => [entry.item.id, entry.removed])).toEqual([
      ['通知1', true],
      ['通知3', false],
    ])
  })

  it('つなぎ直しで同じBAN・タイムアウトがまた届いても、そのあとのその人の発言には印を付けない', () => {
    // 前提: タイムアウトが明けたあとに、同じ人の発言2が届いている
    const 消去 = { kind: 'clearUser' as const, ...目印('通知2'), userId: 常連さん.id }
    const 並び = applyFeedItems(EMPTY_FEED, [発言('通知1', '発言1'), 消去, 発言('通知3', '発言2')])

    const つなぎ直した後 = applyFeedItems(並び, [消去])

    expect(つなぎ直した後.entries.map((entry) => [entry.item.id, entry.removed])).toEqual([
      ['通知1', true],
      ['通知3', false],
    ])
  })

  it('並べるのは上限の件数までで、古いものから落とす', () => {
    const 多すぎる = Array.from({ length: MAX_ENTRIES + 1 }, (_, 番号) => 発言(`通知${番号}`, `発言${番号}`))

    const feed = applyFeedItems(EMPTY_FEED, 多すぎる)

    expect(feed.entries).toHaveLength(MAX_ENTRIES)
    expect(feed.entries[0]?.item.id).toBe('通知1')
  })
})

describe('describeEvent', () => {
  const お知らせ = (notice: Extract<FeedItem, { kind: 'notice' }>['notice'], user: typeof 常連さん | null = 常連さん): EventItem => ({
    kind: 'notice',
    ...目印('通知'),
    messageId: 'お知らせ',
    user,
    color: null,
    badges: [],
    fragments: [],
    notice,
  })

  it.each<[string, EventItem, string]>([
    ['新規サブスク', お知らせ({ type: 'sub', tier: '1000', prime: false }), '常連さん さんがサブスクしました（Tier 1）'],
    ['プライムのサブスク', お知らせ({ type: 'sub', tier: '1000', prime: true }), '常連さん さんがサブスクしました（Prime）'],
    ['継続サブスク', お知らせ({ type: 'resub', tier: '2000', prime: false, months: 14 }), '常連さん さんが14か月目のサブスクを継続しました（Tier 2）'],
    ['1人へのギフト', お知らせ({ type: 'subGift', tier: '1000', recipient: '初見さん' }), '常連さん さんが 初見さん さんにサブスクをギフトしました（Tier 1）'],
    ['匿名でまとめて贈るギフト', お知らせ({ type: 'communityGift', tier: '3000', count: 5 }, null), '匿名の人がサブスクを5件ギフトしました（Tier 3）'],
    ['レイド', お知らせ({ type: 'raid', viewers: 42 }), '常連さん さんが42人でレイドしてきました'],
    ['アナウンス', お知らせ({ type: 'announcement' }), '常連さん さんのアナウンス'],
    ['個別に扱わない種類', お知らせ({ type: 'other', systemMessage: 'jouren_san just earned a new 1K Bits badge!' }), 'jouren_san just earned a new 1K Bits badge!'],
    ['引き換え', { kind: 'redemption', ...目印('通知'), user: 常連さん, reward: '質問する', cost: 500, input: '' }, '常連さん さんが「質問する」を引き換えました（500pt）'],
    ['フォロー', { kind: 'follow', ...目印('通知'), user: 初見さん }, '初見さん さんがフォローしました'],
  ])('%s を1行の文にする', (_, item, 文) => {
    expect(describeEvent(item)).toBe(文)
  })
})

describe('toFocusPick', () => {
  it('発言を、注目コメントとして取り上げる1件に直す（エモートは名前の文字のままつなげる）', () => {
    const エモート入りの発言: ChatItem = {
      kind: 'chat',
      ...目印('通知'),
      messageId: '発言1',
      user: 常連さん,
      color: null,
      badges: [],
      fragments: [
        { text: '今日のゲーム面白い ', emoteId: null },
        { text: 'Kappa', emoteId: '25' },
      ],
      bits: null,
      reply: null,
    }

    expect(toFocusPick(エモート入りの発言)).toEqual({
      messageId: '発言1',
      login: 'jouren_san',
      displayName: '常連さん',
      text: '今日のゲーム面白い Kappa',
    })
  })
})

/** 既読・未読の付け替えを1件作る */
const 付け替え = (id: string, messageId: string, read: boolean, by: 'manual' | 'jev' = 'manual'): FeedItem => ({ kind: 'read', ...目印(id), messageId, read, by })

describe('applyFeedItems（既読・未読）', () => {
  it('届いたばかりの発言は未読である', () => {
    const feed = applyFeedItems(EMPTY_FEED, [発言('通知1', '発言1')])

    expect(feed.entries[0]?.read).toBeNull()
  })

  it('既読の付け替えが届くと、その発言に誰が既読にしたかの印を付ける（付け替えは行として並べない）', () => {
    const feed = applyFeedItems(EMPTY_FEED, [発言('通知1', '発言1'), 発言('通知2', '発言2'), 付け替え('付け替え1', '発言1', true)])

    expect(feed.entries.map((entry) => [entry.item.id, entry.read])).toEqual([
      ['通知1', 'manual'],
      ['通知2', null],
    ])
  })

  it('未読に戻す付け替えが届くと、印を外す', () => {
    const feed = applyFeedItems(EMPTY_FEED, [発言('通知1', '発言1'), 付け替え('付け替え1', '発言1', true), 付け替え('付け替え2', '発言1', false)])

    expect(feed.entries[0]?.read).toBeNull()
  })

  it('Jev が既読にしたものは、手で既読にしたものと見分けられる', () => {
    const feed = applyFeedItems(EMPTY_FEED, [発言('通知1', '発言1'), 付け替え('付け替え1', '発言1', true, 'jev')])

    expect(feed.entries[0]?.read).toBe('jev')
  })

  it('開き直したときの履歴から、最後に付け替えた状態を戻す', () => {
    // 履歴には発言と付け替えが届いた順に入っている
    const 履歴 = parseFeedMessage(
      JSON.stringify({ type: 'backlog', items: [発言('通知1', '発言1'), 付け替え('付け替え1', '発言1', true), 付け替え('付け替え2', '発言1', false), 付け替え('付け替え3', '発言1', true)] }),
    )
    if (履歴.type !== 'backlog') throw new Error('履歴として読めるはず')

    expect(applyFeedItems(EMPTY_FEED, 履歴.items).entries[0]?.read).toBe('manual')
  })

  it('並びから落ちた発言への付け替えは無視する', () => {
    const feed = applyFeedItems(EMPTY_FEED, [発言('通知1', '発言1'), 付け替え('付け替え1', 'もう並んでいない発言', true)])

    expect(feed.entries.map((entry) => entry.read)).toEqual([null])
  })
})

describe('needsReaction・isLongUnread', () => {
  const 届いた時刻 = Date.parse('2026-09-29T12:00:00Z')

  /** 並びの1行を作る */
  const 行 = (item: FeedItem, 上書き: Partial<FeedEntry> = {}): FeedEntry => {
    if (item.kind !== 'chat') throw new Error('発言の行だけを作る')
    return { item, removed: false, read: null, ...上書き }
  }

  /** 配信者自身の発言（broadcaster のバッジが付く） */
  const 配信者の発言: FeedItem = {
    ...(発言('通知9', '配信者の発言', { id: '12345', login: 'haishinsha', name: '配信者' }, 'みなさんこんばんは') as ChatItem),
    badges: [{ setId: 'broadcaster', versionId: '1' }],
  }

  it('視聴者の発言は、反応したかを見る対象である', () => {
    expect(needsReaction(行(発言('通知1', '発言1')))).toBe(true)
  })

  it('配信者自身の発言は、反応したかを見る対象にしない', () => {
    expect(needsReaction(行(配信者の発言))).toBe(false)
  })

  it('モデレーターに消された発言は、反応したかを見る対象にしない', () => {
    expect(needsReaction(行(発言('通知1', '発言1'), { removed: true }))).toBe(false)
  })

  it('出来事の行は、反応したかを見る対象にしない（既読の印を付けるのは発言だけ）', () => {
    const フォロー: FeedEntry = { item: { kind: 'follow', ...目印('通知2'), user: 初見さん }, removed: false, read: null }

    expect(needsReaction(フォロー)).toBe(false)
  })

  it('届いてから決めた時間が経っても未読のままなら、しばらく未読とみなす', () => {
    const 未読の行 = 行(発言('通知1', '発言1'))

    expect(isLongUnread(未読の行, 届いた時刻 + UNREAD_HIGHLIGHT_MS - 1)).toBe(false)
    expect(isLongUnread(未読の行, 届いた時刻 + UNREAD_HIGHLIGHT_MS)).toBe(true)
  })

  it('既読にした発言・反応したかを見ない発言は、時間が経ってもしばらく未読とみなさない', () => {
    const ずっと後 = 届いた時刻 + UNREAD_HIGHLIGHT_MS * 10

    expect(isLongUnread(行(発言('通知1', '発言1'), { read: 'manual' }), ずっと後)).toBe(false)
    expect(isLongUnread(行(配信者の発言), ずっと後)).toBe(false)
    expect(isLongUnread(行(発言('通知1', '発言1'), { removed: true }), ずっと後)).toBe(false)
  })

  it('目立たせるまでの時間は3分に決め切る（設定項目にしない）', () => {
    expect(UNREAD_HIGHLIGHT_MS).toBe(3 * 60 * 1000)
  })
})
