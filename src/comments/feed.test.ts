/**
 * コメントビューアーの流れ（feed.ts）のテスト
 *
 * Worker（worker/comment-channel.ts）から届いた文字列を読み取れること、並びへ積むときに
 * 再送された1件を二重に並べないこと、モデレーターの操作で消えた発言に印を付けることを確かめる。
 */
import { describe, expect, it } from 'vitest'
import { applyFeedItems, describeEvent, EMPTY_FEED, MAX_ENTRIES, parseFeedMessage, type EventItem, type FeedItem } from './feed'

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
