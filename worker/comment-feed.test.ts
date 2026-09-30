/**
 * コメントビューアーに流す1件への変換（comment-feed.ts）のテスト
 *
 * EventSub の通知の中身（event）を、コメントビューアー（/comments/）が並べる1件に直せるかを確かめる。
 * 通知の形は Twitch の EventSub のリファレンスにある例に合わせている。
 */
import { describe, expect, it } from 'vitest'
import { toFeedItem, type FeedItem } from './comment-feed'

/** どの通知にも付ける、フィードの1件としての目印（Webhook の Twitch-Eventsub-Message-Id と届いた時刻） */
const marker = { id: 'eventsub-message-0001', at: Date.parse('2026-09-29T12:00:00Z') }

const broadcaster = { broadcaster_user_id: '12345', broadcaster_user_login: 'haishinsha', broadcaster_user_name: '配信者' }

/** channel.chat.message の中身を作る。上書きしたい項目だけを渡す */
const message = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...broadcaster,
  chatter_user_id: '777',
  chatter_user_login: 'jouren_san',
  chatter_user_name: '常連さん',
  message_id: 'chat-message-0001',
  message: {
    text: 'こんばんは Kappa',
    fragments: [
      { type: 'text', text: 'こんばんは ', cheermote: null, emote: null, mention: null },
      { type: 'emote', text: 'Kappa', cheermote: null, emote: { id: '25', emote_set_id: '0' }, mention: null },
    ],
  },
  color: '#FF4500',
  badges: [{ set_id: 'subscriber', id: '12', info: '14' }],
  message_type: 'text',
  cheer: null,
  reply: null,
  ...overrides,
})

describe('toFeedItem: チャットの発言', () => {
  it('発言者・色・バッジ・本文の断片（エモートはIDつき）を取り出す', () => {
    expect(toFeedItem('channel.chat.message', message(), marker, false)).toEqual({
      kind: 'chat',
      ...marker,
      messageId: 'chat-message-0001',
      user: { id: '777', login: 'jouren_san', name: '常連さん' },
      color: '#FF4500',
      badges: [{ setId: 'subscriber', versionId: '12' }],
      fragments: [
        { text: 'こんばんは ', emoteId: null },
        { text: 'Kappa', emoteId: '25' },
      ],
      bits: null,
      reply: null,
      firstOfStream: false,
    } satisfies FeedItem)
  })

  it('その配信で初めての発言なら、その印を付ける（判定は呼び出し側が済ませて渡す）', () => {
    expect(toFeedItem('channel.chat.message', message(), marker, true)).toMatchObject({ kind: 'chat', firstOfStream: true })
  })

  it('名前の色を設定していない人（空文字で届く）は色なしにする', () => {
    expect(toFeedItem('channel.chat.message', message({ color: '' }), marker, false)).toMatchObject({ color: null })
  })

  it('ビッツを贈った発言は、贈ったビッツ数を持つ', () => {
    expect(toFeedItem('channel.chat.message', message({ cheer: { bits: 500 } }), marker, false)).toMatchObject({ bits: 500 })
  })

  it('返信の発言は、返信先の名前と本文を持つ', () => {
    const reply = message({
      reply: {
        parent_message_id: 'chat-message-0000',
        parent_message_body: '今日は何のゲームですか',
        parent_user_id: '888',
        parent_user_name: '初見さん',
        parent_user_login: 'shoken_san',
      },
    })
    expect(toFeedItem('channel.chat.message', reply, marker, false)).toMatchObject({ reply: { name: '初見さん', text: '今日は何のゲームですか' } })
  })

  it('本文の断片が届かない発言は、黙って本文なしにせずエラーにする', () => {
    expect(() => toFeedItem('channel.chat.message', message({ message: { text: 'こんばんは' } }), marker, false)).toThrow(/fragments/)
  })
})

/** channel.chat.notification の中身を作る */
const notice = (notice_type: string, body: Record<string, unknown>): Record<string, unknown> => ({
  ...broadcaster,
  chatter_user_id: '777',
  chatter_user_login: 'jouren_san',
  chatter_user_name: '常連さん',
  chatter_is_anonymous: false,
  color: '',
  badges: [],
  system_message: 'jouren_san subscribed at Tier 1.',
  message_id: 'notice-message-0001',
  message: { text: '', fragments: [] },
  notice_type,
  sub: null,
  resub: null,
  sub_gift: null,
  community_sub_gift: null,
  raid: null,
  announcement: null,
  ...body,
})

describe('toFeedItem: チャットのお知らせ（サブスク・ギフト・レイド・アナウンス）', () => {
  it('新規サブスクは、階層とプライムかどうかを持つ', () => {
    const item = toFeedItem('channel.chat.notification', notice('sub', { sub: { sub_tier: '1000', is_prime: false, duration_months: 1 } }), marker, false)
    expect(item).toMatchObject({
      kind: 'notice',
      messageId: 'notice-message-0001',
      user: { id: '777', login: 'jouren_san', name: '常連さん' },
      notice: { type: 'sub', tier: '1000', prime: false },
    })
  })

  it('継続サブスクは、通算の月数と添えられた発言を持つ', () => {
    const resub = notice('resub', {
      resub: { cumulative_months: 14, duration_months: 1, sub_tier: '2000', is_prime: false, is_gift: false },
      message: { text: '今月もよろしく', fragments: [{ type: 'text', text: '今月もよろしく', cheermote: null, emote: null, mention: null }] },
    })
    expect(toFeedItem('channel.chat.notification', resub, marker, false)).toMatchObject({
      notice: { type: 'resub', tier: '2000', prime: false, months: 14 },
      fragments: [{ text: '今月もよろしく', emoteId: null }],
    })
  })

  it('1人へのギフトは、受け取った人の名前を持つ', () => {
    const gift = notice('sub_gift', {
      sub_gift: { duration_months: 1, cumulative_total: null, recipient_user_id: '888', recipient_user_name: '初見さん', recipient_user_login: 'shoken_san', sub_tier: '1000' },
    })
    expect(toFeedItem('channel.chat.notification', gift, marker, false)).toMatchObject({ notice: { type: 'subGift', tier: '1000', recipient: '初見さん' } })
  })

  it('まとめて贈るギフトは、贈った数を持つ', () => {
    const bulk = notice('community_sub_gift', { community_sub_gift: { id: 'gift-0001', total: 5, sub_tier: '1000', cumulative_total: 20 } })
    expect(toFeedItem('channel.chat.notification', bulk, marker, false)).toMatchObject({ notice: { type: 'communityGift', tier: '1000', count: 5 } })
  })

  it('匿名のギフトは、贈った人を持たない', () => {
    const anonymous = notice('community_sub_gift', {
      chatter_is_anonymous: true,
      community_sub_gift: { id: 'gift-0002', total: 1, sub_tier: '1000', cumulative_total: null },
    })
    expect(toFeedItem('channel.chat.notification', anonymous, marker, false)).toMatchObject({ user: null })
  })

  it('レイドは、連れてきた人数を持つ', () => {
    const raid = notice('raid', {
      raid: { user_id: '999', user_name: 'レイドする人', user_login: 'raid_suru_hito', viewer_count: 42, profile_image_url: 'https://example.com/a.png' },
    })
    expect(toFeedItem('channel.chat.notification', raid, marker, false)).toMatchObject({ notice: { type: 'raid', viewers: 42 } })
  })

  it('アナウンスは、本文を断片として持つ', () => {
    const announcement = notice('announcement', {
      announcement: { color: 'PRIMARY' },
      message: { text: '次は歌枠です', fragments: [{ type: 'text', text: '次は歌枠です', cheermote: null, emote: null, mention: null }] },
    })
    expect(toFeedItem('channel.chat.notification', announcement, marker, false)).toMatchObject({
      notice: { type: 'announcement' },
      fragments: [{ text: '次は歌枠です', emoteId: null }],
    })
  })

  it('個別に扱わない種類は、捨てずに Twitch の説明文をそのまま持つ', () => {
    const cheer = notice('bits_badge_tier', { system_message: 'jouren_san just earned a new 1K Bits badge!', bits_badge_tier: { tier: 1000 } })
    expect(toFeedItem('channel.chat.notification', cheer, marker, false)).toMatchObject({
      notice: { type: 'other', systemMessage: 'jouren_san just earned a new 1K Bits badge!' },
    })
  })

  it('種類に対応する中身が欠けていれば、黙って捨てずにエラーにする', () => {
    expect(() => toFeedItem('channel.chat.notification', notice('raid', { raid: null }), marker, false)).toThrow(/raid/)
  })
})

describe('toFeedItem: チャンネルポイントの引き換えとフォロー', () => {
  it('引き換えは、報酬の名前・ポイント・視聴者が書いた文を持つ', () => {
    const redemption = {
      ...broadcaster,
      id: 'redemption-0001',
      user_id: '777',
      user_login: 'jouren_san',
      user_name: '常連さん',
      user_input: '好きな食べ物は？',
      status: 'unfulfilled',
      reward: { id: 'reward-0001', title: '質問する', cost: 500, prompt: '' },
      redeemed_at: '2026-09-29T12:00:00Z',
    }
    expect(toFeedItem('channel.channel_points_custom_reward_redemption.add', redemption, marker, false)).toEqual({
      kind: 'redemption',
      ...marker,
      user: { id: '777', login: 'jouren_san', name: '常連さん' },
      reward: '質問する',
      cost: 500,
      input: '好きな食べ物は？',
    } satisfies FeedItem)
  })

  it('フォローは、フォローした人を持つ', () => {
    const follow = { ...broadcaster, user_id: '888', user_login: 'shoken_san', user_name: '初見さん', followed_at: '2026-09-29T12:00:00Z' }
    expect(toFeedItem('channel.follow', follow, marker, false)).toEqual({
      kind: 'follow',
      ...marker,
      user: { id: '888', login: 'shoken_san', name: '初見さん' },
    } satisfies FeedItem)
  })
})

describe('toFeedItem: モデレーターの操作', () => {
  it('発言の削除は、消えた発言のIDを持つ', () => {
    const deletion = { ...broadcaster, target_user_id: '777', target_user_login: 'jouren_san', target_user_name: '常連さん', message_id: 'chat-message-0001' }
    expect(toFeedItem('channel.chat.message_delete', deletion, marker, false)).toEqual({ kind: 'delete', ...marker, messageId: 'chat-message-0001' } satisfies FeedItem)
  })

  it('BAN・タイムアウトによる消去は、消えた人のIDを持つ', () => {
    const clear = { ...broadcaster, target_user_id: '777', target_user_login: 'jouren_san', target_user_name: '常連さん' }
    expect(toFeedItem('channel.chat.clear_user_messages', clear, marker, false)).toEqual({ kind: 'clearUser', ...marker, userId: '777' } satisfies FeedItem)
  })

  it('チャットの全消去は、目印だけを持つ', () => {
    expect(toFeedItem('channel.chat.clear', broadcaster, marker, false)).toEqual({ kind: 'clear', ...marker } satisfies FeedItem)
  })
})

describe('toFeedItem: コメントビューアーに流さない通知', () => {
  it('チャットのお知らせと重なる通知（サブスク・レイド）と、配信の開始・広告は流さない', () => {
    for (const type of ['channel.subscribe', 'channel.subscription.message', 'channel.raid', 'stream.online', 'channel.ad_break.begin']) {
      expect(toFeedItem(type, {}, marker, false)).toBeNull()
    }
  })
})
