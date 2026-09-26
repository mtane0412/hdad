/**
 * アラートのイベントの読み取り（alert-event.ts）のテスト
 *
 * Twitchから届いた通知の中身から、条件の照合と文言の差し込みに使う項目を取り出せること、
 * トリガーの一覧から動作（チャットに送る・アナウンスを送る・アラートを出す）を選べることを確認する。
 * 「その配信で初めての発言か」は通知の中身では決まらないので、判定結果（ConditionState）を値で受け取る形になっている。
 */
import { describe, expect, it } from 'vitest'
import type { AlertConfig, ResolvedTrigger, StoredTrigger } from './alert-config'
import type { StoredCondition } from './trigger-menu'
import { resolveTrigger } from './alert-config'
import {
  aiChatsFor,
  alertsFor,
  announcementsFor,
  chatMessagesFor,
  extract,
  fillMessage,
  hasAlertAction,
  matches,
  requiresChatHistory,
  requiresFirstChatOfStream,
  requiresStreamSummary,
  shoutoutsFor,
  type ConditionState,
} from './alert-event'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
const CHAT_MESSAGE = 'channel.chat.message'
const AD_BREAK_BEGIN = 'channel.ad_break.begin'
const AD_BREAK_END = 'channel.ad_break.end'

/** Twitchから届く広告の開始の通知の中身。自動で入った3分の広告を表す */
const 広告の通知 = {
  duration_seconds: 180,
  started_at: '2026-09-25T12:00:00Z',
  is_automatic: true,
  broadcaster_user_id: '配信者ID',
  broadcaster_user_login: 'tanenobu',
  broadcaster_user_name: 'たねのぶ',
  requester_user_id: '配信者ID',
  requester_user_login: 'tanenobu',
  requester_user_name: 'たねのぶ',
}

/** 通知の中身だけでは決まらない条件の判定結果。この一群のテストではふだんの発言（その配信で2回目以降）として扱う */
const 初回ではない: ConditionState = { firstChatOfStream: false, firstChatEver: false, daysSinceLastChat: 0 }
/** その配信で初めての発言だった場合の判定結果 */
const 初回である: ConditionState = { firstChatOfStream: true, firstChatEver: false, daysSinceLastChat: 3 }

describe('extract', () => {
  it('チャンネルポイント交換から、交換した人と報酬を取り出す', () => {
    const event = { user_name: '田中太郎', user_login: 'tanaka_taro', reward: { id: '報酬ID-乾杯', title: '乾杯する' } }

    expect(extract(REDEMPTION, event)).toEqual({
      event: REDEMPTION,
      userName: '田中太郎',
      userLogin: 'tanaka_taro',
      rewardId: '報酬ID-乾杯',
      rewardTitle: '乾杯する',
    })
  })

  it('フォローから、フォローした人を取り出す', () => {
    expect(extract('channel.follow', { user_name: '田中太郎', user_login: 'tanaka_taro' })).toEqual({
      event: 'channel.follow',
      userName: '田中太郎',
      userLogin: 'tanaka_taro',
    })
  })

  it('新規サブスクから、サブスクした人とティアを取り出す', () => {
    expect(extract('channel.subscribe', { user_name: '田中太郎', user_login: 'tanaka_taro', tier: '1000' })).toEqual({
      event: 'channel.subscribe',
      userName: '田中太郎',
      userLogin: 'tanaka_taro',
      tier: '1000',
    })
  })

  it('継続サブスクのメッセージから、継続月数も取り出す', () => {
    const event = { user_name: '田中太郎', user_login: 'tanaka_taro', tier: '2000', cumulative_months: 12 }

    expect(extract('channel.subscription.message', event)).toEqual({
      event: 'channel.subscription.message',
      userName: '田中太郎',
      userLogin: 'tanaka_taro',
      tier: '2000',
      cumulativeMonths: 12,
    })
  })

  it('レイドから、レイドしてきた配信者と人数を取り出す（受け取る側は to_broadcaster なので from_broadcaster を読む）', () => {
    const event = {
      from_broadcaster_user_id: 'レイド元のユーザーID',
      from_broadcaster_user_name: '山田花子',
      from_broadcaster_user_login: 'yamada_hanako',
      to_broadcaster_user_name: '配信者本人',
      viewers: 42,
    }

    expect(extract('channel.raid', event)).toEqual({
      event: 'channel.raid',
      userId: 'レイド元のユーザーID',
      userName: '山田花子',
      userLogin: 'yamada_hanako',
      viewers: 42,
    })
  })

  it('チャットの発言から、発言者と本文を取り出す', () => {
    const event = {
      broadcaster_user_id: '配信者ID',
      chatter_user_id: '発言者ID',
      chatter_user_login: 'tanaka_taro',
      chatter_user_name: '田中太郎',
      message_id: '発言ID-1',
      message: { text: 'おはようございます' },
    }

    expect(extract(CHAT_MESSAGE, event)).toEqual({ event: CHAT_MESSAGE, userName: '田中太郎', userLogin: 'tanaka_taro', text: 'おはようございます' })
  })

  it('広告の開始から、長さ（秒）と自動かどうか、打った人を取り出す', () => {
    expect(extract(AD_BREAK_BEGIN, 広告の通知)).toEqual({
      event: AD_BREAK_BEGIN,
      userName: 'たねのぶ',
      userLogin: 'tanenobu',
      durationSeconds: 180,
      automatic: true,
    })
  })

  it('広告の終了も開始と同じ中身から取り出す（終了はWorkerが同じ中身で作る擬似イベントなので）', () => {
    expect(extract(AD_BREAK_END, 広告の通知)).toEqual({
      event: AD_BREAK_END,
      userName: 'たねのぶ',
      userLogin: 'tanenobu',
      durationSeconds: 180,
      automatic: true,
    })
  })

  it('対応していないイベントの種類は null を返す（Twitchが種類を増やしてもWorkerを止めない）', () => {
    expect(extract('channel.cheer', { user_name: '田中太郎' })).toBeNull()
  })

  it('通知の中身が想定と違えば、どの項目が足りないかを示してエラーにする', () => {
    expect(() => extract('channel.follow', { user_login: 'tanaka' })).toThrowError(/user_name/)
    expect(() =>
      extract('channel.raid', {
        from_broadcaster_user_id: 'レイド元のユーザーID',
        from_broadcaster_user_name: '山田花子',
        from_broadcaster_user_login: 'yamada_hanako',
      }),
    ).toThrowError(/viewers/)
    expect(() => extract(REDEMPTION, { user_name: '田中太郎', user_login: 'tanaka_taro' })).toThrowError(/reward/)
  })
})

describe('matches', () => {
  /** チャンネルポイント交換のトリガー。条件だけを差し替えて確かめる */
  const 交換のトリガー = (conditions: StoredCondition[]): ResolvedTrigger => ({
    kind: 'reward',
    event: REDEMPTION,
    conditions,
    actions: [{ type: 'chat', message: '乾杯！' }],
  })
  const 交換した = { event: REDEMPTION, userName: '田中太郎', userLogin: 'tanaka_taro', rewardId: '報酬ID-乾杯', rewardTitle: '乾杯する' } as const

  it('イベントの種類が違えば当てはまらない', () => {
    const フォローのトリガー: ResolvedTrigger = { kind: 'follow', event: 'channel.follow', conditions: [], actions: [{ type: 'chat', message: 'ありがとう' }] }

    expect(matches(フォローのトリガー, 交換した, 初回ではない)).toBe(false)
  })

  it('条件が1件もないトリガーは、そのイベントならいつでも当てはまる', () => {
    expect(matches(交換のトリガー([]), 交換した, 初回ではない)).toBe(true)
  })

  it('reward の条件は、報酬IDが同じときだけ当てはまる', () => {
    expect(matches(交換のトリガー([{ kind: 'reward', rewardId: '報酬ID-乾杯' }]), 交換した, 初回ではない)).toBe(true)
    expect(matches(交換のトリガー([{ kind: 'reward', rewardId: '報酬ID-別の報酬' }]), 交換した, 初回ではない)).toBe(false)
  })

  it('user の条件は、相手のユーザー名が同じときだけ当てはまる', () => {
    expect(matches(交換のトリガー([{ kind: 'user', login: 'tanaka_taro' }]), 交換した, 初回ではない)).toBe(true)
    expect(matches(交換のトリガー([{ kind: 'user', login: 'yamada_hanako' }]), 交換した, 初回ではない)).toBe(false)
  })

  it('user の条件は大文字小文字を区別しない（Twitchのユーザー名は小文字だが、配信者が表示名の綴りで入れても当てる）', () => {
    expect(matches(交換のトリガー([{ kind: 'user', login: 'Tanaka_Taro' }]), 交換した, 初回ではない)).toBe(true)
  })

  it('条件が2つあれば、すべてを満たしたときだけ当てはまる（and）', () => {
    const 報酬とユーザーの両方: StoredCondition[] = [
      { kind: 'reward', rewardId: '報酬ID-乾杯' },
      { kind: 'user', login: 'tanaka_taro' },
    ]
    const 報酬だけ合う: StoredCondition[] = [
      { kind: 'reward', rewardId: '報酬ID-乾杯' },
      { kind: 'user', login: 'yamada_hanako' },
    ]

    expect(matches(交換のトリガー(報酬とユーザーの両方), 交換した, 初回ではない)).toBe(true)
    expect(matches(交換のトリガー(報酬だけ合う), 交換した, 初回ではない)).toBe(false)
  })

  it('text の条件は、本文にその文字を含むときだけ当てはまる（部分一致）', () => {
    const チャットのトリガー = (conditions: StoredCondition[]): ResolvedTrigger => ({ kind: 'everyMessage', event: CHAT_MESSAGE, conditions, actions: [{ type: 'chat', message: 'やあ' }] })
    const 発言した = { event: CHAT_MESSAGE, userName: '田中太郎', userLogin: 'tanaka_taro', text: 'みなさんおはようございます' } as const

    expect(matches(チャットのトリガー([{ kind: 'text', contains: 'おはよう' }]), 発言した, 初回ではない)).toBe(true)
    expect(matches(チャットのトリガー([{ kind: 'text', contains: 'こんばんは' }]), 発言した, 初回ではない)).toBe(false)
  })

  it('text の条件は大文字小文字を区別しない', () => {
    const チャットのトリガー: ResolvedTrigger = { kind: 'everyMessage', event: CHAT_MESSAGE, conditions: [{ kind: 'text', contains: 'Hello' }], actions: [{ type: 'chat', message: 'やあ' }] }
    const 発言した = { event: CHAT_MESSAGE, userName: '田中太郎', userLogin: 'tanaka_taro', text: 'HELLO everyone' } as const

    expect(matches(チャットのトリガー, 発言した, 初回ではない)).toBe(true)
  })

  it('text の条件はチャットの発言以外には当てはまらない（既定メニューからは作れない組み合わせだが、照合でも通さない）', () => {
    const フォローに文面: ResolvedTrigger = { kind: 'follow', event: 'channel.follow', conditions: [{ kind: 'text', contains: 'おはよう' }], actions: [{ type: 'chat', message: 'ありがとう' }] }
    const フォローした = { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' } as const

    expect(matches(フォローに文面, フォローした, 初回ではない)).toBe(false)
  })

  it('automatic の条件は、広告が自動で入ったかどうかが一致するときだけ当てはまる', () => {
    const 広告のトリガー = (conditions: StoredCondition[]): ResolvedTrigger => ({ kind: 'adBreakBegin', event: AD_BREAK_BEGIN, conditions, actions: [{ type: 'chat', message: '広告です' }] })
    const 自動で入った = { event: AD_BREAK_BEGIN, userName: 'たねのぶ', userLogin: 'tanenobu', durationSeconds: 180, automatic: true } as const

    expect(matches(広告のトリガー([{ kind: 'automatic', automatic: true }]), 自動で入った, 初回ではない)).toBe(true)
    expect(matches(広告のトリガー([{ kind: 'automatic', automatic: false }]), 自動で入った, 初回ではない)).toBe(false)
  })

  it('automatic の条件は広告以外には当てはまらない（既定メニューからは作れない組み合わせだが、照合でも通さない）', () => {
    const フォローに自動かどうか: ResolvedTrigger = {
      kind: 'follow',
      event: 'channel.follow',
      conditions: [{ kind: 'automatic', automatic: true }],
      actions: [{ type: 'chat', message: 'ありがとう' }],
    }
    const フォローした = { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' } as const

    expect(matches(フォローに自動かどうか, フォローした, 初回ではない)).toBe(false)
  })

  it('reward の条件はチャンネルポイント交換以外には当てはまらない（既定メニューからは作れない組み合わせだが、照合でも通さない）', () => {
    const フォローに報酬: ResolvedTrigger = { kind: 'follow', event: 'channel.follow', conditions: [{ kind: 'reward', rewardId: '報酬ID-乾杯' }], actions: [{ type: 'chat', message: 'ありがとう' }] }
    const フォローした = { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' } as const

    expect(matches(フォローに報酬, フォローした, 初回ではない)).toBe(false)
  })
})

describe('fillMessage', () => {
  it('イベントごとの差し込み語を値に置き換える', () => {
    const 継続サブスク = { event: 'channel.subscription.message', userName: '田中太郎', userLogin: 'tanaka_taro', tier: '2000', cumulativeMonths: 12 } as const

    expect(fillMessage('{user} さん、ティア{tier}で{months}か月ありがとう！', 継続サブスク, null)).toBe('田中太郎 さん、ティア2で12か月ありがとう！')
  })

  it('そのイベントにない差し込み語は残す（入力の誤りに配信者が気付けるようにする）', () => {
    expect(fillMessage('{user} さん、{viewers}人', { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' }, null)).toBe('田中太郎 さん、{viewers}人')
  })

  it('チャットの発言では、{message} が本文に置き換わる', () => {
    const 発言した = { event: CHAT_MESSAGE, userName: '田中太郎', userLogin: 'tanaka_taro', text: 'おはよう' } as const

    expect(fillMessage('{user} さんが「{message}」と言いました', 発言した, null)).toBe('田中太郎 さんが「おはよう」と言いました')
  })

  it('広告では、{duration} が広告の長さ（秒）に置き換わる', () => {
    const 広告が始まった = { event: AD_BREAK_BEGIN, userName: 'たねのぶ', userLogin: 'tanenobu', durationSeconds: 180, automatic: true } as const

    expect(fillMessage('広告が{duration}秒入ります。終わるまでお待ちください', 広告が始まった, null)).toBe('広告が180秒入ります。終わるまでお待ちください')
  })

  it('広告の終了でも {duration} が使える', () => {
    const 広告が終わった = { event: AD_BREAK_END, userName: 'たねのぶ', userLogin: 'tanenobu', durationSeconds: 90, automatic: false } as const

    expect(fillMessage('{duration}秒の広告が終わりました。おかえりなさい', 広告が終わった, null)).toBe('90秒の広告が終わりました。おかえりなさい')
  })

  it('報酬名に $& のような置換の特殊な指定が含まれていても、そのまま差し込む', () => {
    const 交換した = { event: REDEMPTION, userName: '田中太郎', userLogin: 'tanaka_taro', rewardId: '報酬ID', rewardTitle: '$& と $1 の報酬' } as const

    expect(fillMessage('{reward} を交換しました', 交換した, null)).toBe('$& と $1 の報酬 を交換しました')
  })

  it('配信のあらすじを {summary} に差し込む（イベント種別によらず使える）', () => {
    const フォローした = { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' } as const

    expect(fillMessage('{user} さん、いらっしゃい。{summary}', フォローした, '配信者は新しいゲームを遊んでいます')).toBe(
      '田中太郎 さん、いらっしゃい。配信者は新しいゲームを遊んでいます',
    )
  })

  it('あらすじが無ければ、{summary} を残さずその旨を差し込む（文言が欠けたように見せない）', () => {
    const フォローした = { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' } as const

    expect(fillMessage('これまでのあらすじ: {summary}', フォローした, null)).toBe('これまでのあらすじ: まだあらすじがありません')
  })

  it('あらすじに $& のような置換の特殊な指定が含まれていても、そのまま差し込む', () => {
    const フォローした = { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' } as const

    expect(fillMessage('{summary}', フォローした, '$& と $1 の話をしていました')).toBe('$& と $1 の話をしていました')
  })
})

describe('aiChatsFor', () => {
  const 設定 = (triggers: StoredTrigger[]): AlertConfig => ({ triggers })
  const フォローの通知 = { user_name: '田中太郎', user_login: 'tanaka_taro' }

  it('当てはまるトリガーの指示と、読み取ったイベントの中身を返す（文面づくりの材料になる）', () => {
    const config = 設定([{ kind: 'follow', actions: [{ type: 'aiChat', instruction: 'お礼を言ってください' }] }])

    expect(aiChatsFor(config, 'channel.follow', フォローの通知, 初回ではない)).toEqual([{
      instruction: 'お礼を言ってください',
      extracted: { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' },
    }])
  })

  it('当てはまるトリガーがなければ null を返す', () => {
    const config = 設定([{ kind: 'raid', actions: [{ type: 'aiChat', instruction: 'お礼を言ってください' }] }])

    expect(aiChatsFor(config, 'channel.follow', フォローの通知, 初回ではない)).toEqual([])
  })

  it('LLMに作らせる動作を持たないトリガー（固定文言のチャットだけ）には反応しない', () => {
    const 固定文言だけ: StoredTrigger = { kind: 'follow', actions: [{ type: 'chat', message: 'ありがとう' }] }

    expect(aiChatsFor(設定([固定文言だけ]), 'channel.follow', フォローの通知, 初回ではない)).toEqual([])
  })

  it('条件を満たさないトリガーには反応しない', () => {
    const 初回だけ: StoredTrigger = {
      kind: 'newViewer',
      actions: [{ type: 'aiChat', instruction: '初めての人を歓迎してください' }],
    }
    const 発言の通知 = {
      message_id: 'chat-1',
      broadcaster_user_id: '1',
      chatter_user_id: '2',
      chatter_user_login: 'hanako',
      chatter_user_name: '花子',
      message: { text: 'こんばんは' },
    }

    expect(aiChatsFor(設定([初回だけ]), CHAT_MESSAGE, 発言の通知, 初回ではない)).toEqual([])
  })
})

describe('chatMessagesFor', () => {
  const 設定 = (triggers: StoredTrigger[]): AlertConfig => ({ triggers })
  const フォローの通知 = { user_name: '田中太郎', user_login: 'tanaka_taro' }

  it('当てはまるトリガーのチャットの文言を、差し込み語を置き換えて返す', () => {
    const config = 設定([{ kind: 'follow', actions: [{ type: 'chat', message: '{user} さん、フォローありがとうございます！' }] }])

    expect(chatMessagesFor(config, 'channel.follow', フォローの通知, 初回ではない, null)).toEqual(['田中太郎 さん、フォローありがとうございます！'])
  })

  it('文言の {summary} に、渡された配信のあらすじを差し込む', () => {
    const config = 設定([{ kind: 'follow', actions: [{ type: 'chat', message: '{user} さん、いま「{summary}」って話をしてます' }] }])

    expect(chatMessagesFor(config, 'channel.follow', フォローの通知, 初回ではない, '新しいゲームを遊んでいます')).toEqual([
      '田中太郎 さん、いま「新しいゲームを遊んでいます」って話をしてます',
    ])
  })

  it('当てはまるトリガーがなければ null を返す', () => {
    const config = 設定([{ kind: 'raid', actions: [{ type: 'chat', message: 'レイドありがとう' }] }])

    expect(chatMessagesFor(config, 'channel.follow', フォローの通知, 初回ではない, null)).toEqual([])
  })

  it('チャットに送る動作を持たないトリガー（アラートを出すだけ）には反応しない', () => {
    const アラートだけ: StoredTrigger = {
      kind: 'follow',
      actions: [{ type: 'alert', mediaId: '素材ID-拍手の音', mediaKind: 'audio', durationSeconds: 5, volume: 0.5, message: '' }],
    }

    expect(chatMessagesFor(設定([アラートだけ]), 'channel.follow', フォローの通知, 初回ではない, null)).toEqual([])
  })

  it('当てはまるトリガーが複数あれば、並びの順にすべて返す（どれかが黙って落とされない）', () => {
    const config = 設定([
      { kind: 'follow', actions: [{ type: 'chat', message: '1つ目の文言' }] },
      { kind: 'follow', actions: [{ type: 'chat', message: '2つ目の文言' }] },
    ])

    expect(chatMessagesFor(config, 'channel.follow', フォローの通知, 初回ではない, null)).toEqual(['1つ目の文言', '2つ目の文言'])
  })

  it('挨拶と「すべての発言」が並んでいれば、どちらも返す（読み上げや効果音は挨拶と同時に鳴ってほしい）', () => {
    const config = 設定([
      { kind: 'newViewer', actions: [{ type: 'chat', message: 'はじめまして！' }] },
      { kind: 'everyMessage', actions: [{ type: 'chat', message: 'どうも' }] },
    ])
    const 初見の発言 = { ...初回ではない, firstChatEver: true }
    const 発言 = {
      broadcaster_user_id: '配信者ID',
      chatter_user_id: '発言者ID',
      chatter_user_login: 'tanaka_taro',
      chatter_user_name: '田中太郎',
      message_id: '発言ID-1',
      message: { text: 'こんにちは' },
    }

    expect(chatMessagesFor(config, CHAT_MESSAGE, 発言, 初見の発言, null)).toEqual(['はじめまして！', 'どうも'])
  })

  it('チャットに送るトリガーがないイベントなら、通知の中身が想定と違ってもエラーにしない（設定していないイベントで止めない）', () => {
    const config = 設定([{ kind: 'raid', actions: [{ type: 'chat', message: 'レイドありがとう' }] }])

    expect(chatMessagesFor(config, 'channel.follow', { user_login: 'tanaka' }, 初回ではない, null)).toEqual([])
  })

  it('対応していないイベントの種類なら null を返す', () => {
    const config = 設定([{ kind: 'follow', actions: [{ type: 'chat', message: 'ありがとう' }] }])

    expect(chatMessagesFor(config, 'stream.online', { id: '配信ID' }, 初回ではない, null)).toEqual([])
  })
})

describe('チャットの発言のトリガー', () => {
  const 発言の通知 = {
    broadcaster_user_id: '配信者ID',
    chatter_user_id: '発言者ID',
    chatter_user_login: 'tanaka_taro',
    chatter_user_name: '田中太郎',
    message_id: '発言ID-1',
    message: { text: 'みなさんおはようございます' },
  }

  it('文面の条件に当てはまる発言で、チャットの文言を返す', () => {
    const 設定: AlertConfig = {
      triggers: [{ kind: 'keyword', contains: 'おはよう', actions: [{ type: 'chat', message: '{user} さん、おはよう！' }] }],
    }

    expect(chatMessagesFor(設定, CHAT_MESSAGE, 発言の通知, 初回ではない, null)).toEqual(['田中太郎 さん、おはよう！'])
  })

  it('発言者の条件に当てはまらない発言では null を返す', () => {
    const 設定: AlertConfig = {
      triggers: [{ kind: 'fromUser', login: 'yamada_hanako', actions: [{ type: 'chat', message: 'やあ' }] }],
    }

    expect(chatMessagesFor(設定, CHAT_MESSAGE, 発言の通知, 初回ではない, null)).toEqual([])
  })

  it('本文を差し込んでTwitchの上限（500文字）を超えたら、末尾を … にして収める', () => {
    const 長い発言 = {
      ...発言の通知,
      message: { text: 'あ'.repeat(500) },
    }
    const 設定: AlertConfig = {
      triggers: [{ kind: 'everyMessage', actions: [{ type: 'chat', message: '{user} さんの発言: {message}' }] }],
    }

    const [送る文言] = chatMessagesFor(設定, CHAT_MESSAGE, 長い発言, 初回ではない, null)

    expect(送る文言).toHaveLength(500)
    expect(送る文言?.endsWith('…')).toBe(true)
    expect(送る文言?.startsWith('田中太郎 さんの発言: ')).toBe(true)
  })

  it('アナウンスの文言も、Twitchの上限（500文字）に収める', () => {
    const 長い発言 = { ...発言の通知, message: { text: 'あ'.repeat(500) } }
    const 設定: AlertConfig = {
      triggers: [{ kind: 'everyMessage', actions: [{ type: 'announce', message: '{message}', color: 'blue' }] }],
    }

    expect(announcementsFor(設定, CHAT_MESSAGE, 長い発言, 初回ではない, null)[0]?.message).toHaveLength(500)
  })

  it('発言の本文をアナウンスの文言に差し込める', () => {
    const 設定: AlertConfig = {
      triggers: [
        {
          kind: 'keyword', contains: 'おはよう',
          actions: [{ type: 'announce', message: '{user}: {message}', color: 'blue' }],
        },
      ],
    }

    expect(announcementsFor(設定, CHAT_MESSAGE, 発言の通知, 初回ではない, null)).toEqual([{ type: 'announce', message: '田中太郎: みなさんおはようございます', color: 'blue' }])
  })

  it('アナウンスの文言の {summary} に、渡された配信のあらすじを差し込む', () => {
    const あらすじを流す: StoredTrigger = {
      kind: 'everyMessage',
      actions: [{ type: 'announce', message: 'これまでのあらすじ: {summary}', color: 'blue' }],
    }

    expect(announcementsFor({ triggers: [あらすじを流す] }, CHAT_MESSAGE, 発言の通知, 初回ではない, '新しいゲームを遊んでいます')[0]?.message).toBe(
      'これまでのあらすじ: 新しいゲームを遊んでいます',
    )
  })
})

describe('挨拶の段（当てはまったうち最も細かい1つだけが発動する）', () => {
  const 発言の通知 = {
    broadcaster_user_id: '配信者ID',
    chatter_user_id: '発言者ID',
    chatter_user_login: 'tanaka_taro',
    chatter_user_name: '田中太郎',
    message_id: '発言ID-1',
    message: { text: 'こんにちは' },
  }
  /** 挨拶の3項目すべてにチャットの効果を付けた設定（配信者が一覧のすべてを埋めた状態） */
  const 挨拶をすべて埋めた: AlertConfig = {
    triggers: [
      { kind: 'newViewer', actions: [{ type: 'chat', message: 'はじめまして！' }] },
      { kind: 'comeback', days: 30, actions: [{ type: 'chat', message: 'お久しぶりです！' }] },
      { kind: 'welcome', actions: [{ type: 'chat', message: 'おかえりなさい！' }] },
    ],
  }

  it('初めて来た人の発言では、初めて来た人の挨拶だけを送る（その配信で最初の発言でもあるが二重にしない）', () => {
    const 初見 = { firstChatOfStream: true, firstChatEver: true, daysSinceLastChat: null }

    expect(chatMessagesFor(挨拶をすべて埋めた, CHAT_MESSAGE, 発言の通知, 初見, null)).toEqual(['はじめまして！'])
  })

  it('久しぶりの人の発言では、久しぶりの挨拶だけを送る', () => {
    const 久しぶり = { firstChatOfStream: true, firstChatEver: false, daysSinceLastChat: 40 }

    expect(chatMessagesFor(挨拶をすべて埋めた, CHAT_MESSAGE, 発言の通知, 久しぶり, null)).toEqual(['お久しぶりです！'])
  })

  it('常連のその配信で最初の発言では、おかえりの挨拶を送る', () => {
    const 常連の初回 = { firstChatOfStream: true, firstChatEver: false, daysSinceLastChat: 1 }

    expect(chatMessagesFor(挨拶をすべて埋めた, CHAT_MESSAGE, 発言の通知, 常連の初回, null)).toEqual(['おかえりなさい！'])
  })

  it('その配信で2通目以降の発言では、挨拶を送らない', () => {
    const 二通目 = { firstChatOfStream: false, firstChatEver: false, daysSinceLastChat: 1 }

    expect(chatMessagesFor(挨拶をすべて埋めた, CHAT_MESSAGE, 発言の通知, 二通目, null)).toEqual([])
  })

  it('挨拶の絞り込みは動作の種類をまたいで効く（初めて来た人にAIチャットを、その配信で最初の人にチャットを付けても二重にならない）', () => {
    const config: AlertConfig = {
      triggers: [
        { kind: 'newViewer', actions: [{ type: 'aiChat', instruction: '歓迎してください' }] },
        { kind: 'welcome', actions: [{ type: 'chat', message: 'おかえりなさい！' }] },
      ],
    }
    const 初見 = { firstChatOfStream: true, firstChatEver: true, daysSinceLastChat: null }

    expect(aiChatsFor(config, CHAT_MESSAGE, 発言の通知, 初見)).toHaveLength(1)
    expect(chatMessagesFor(config, CHAT_MESSAGE, 発言の通知, 初見, null)).toEqual([])
  })

  it('保存されている並びが細かい順でなくても、挨拶の優先順位は変わらない（KVを手で直しても入れ替わらない）', () => {
    const 逆の並び: AlertConfig = {
      triggers: [
        { kind: 'welcome', actions: [{ type: 'chat', message: 'おかえりなさい！' }] },
        { kind: 'newViewer', actions: [{ type: 'chat', message: 'はじめまして！' }] },
      ],
    }
    const 初見 = { firstChatOfStream: true, firstChatEver: true, daysSinceLastChat: null }

    expect(chatMessagesFor(逆の並び, CHAT_MESSAGE, 発言の通知, 初見, null)).toEqual(['はじめまして！'])
  })

  it('挨拶と合言葉は同時に発動する（絞り込みの向きが違うので打ち消さない）', () => {
    const config: AlertConfig = {
      triggers: [
        { kind: 'newViewer', actions: [{ type: 'chat', message: 'はじめまして！' }] },
        { kind: 'keyword', contains: 'こんにちは', actions: [{ type: 'chat', message: 'こんにちは！' }] },
      ],
    }
    const 初見 = { firstChatOfStream: true, firstChatEver: true, daysSinceLastChat: null }

    expect(chatMessagesFor(config, CHAT_MESSAGE, 発言の通知, 初見, null)).toEqual(['はじめまして！', 'こんにちは！'])
  })
})

describe('announcementsFor', () => {
  const 設定 = (triggers: StoredTrigger[]): AlertConfig => ({ triggers })
  const レイドの通知 = {
    from_broadcaster_user_id: 'レイド元のユーザーID',
    from_broadcaster_user_name: '山田花子',
    from_broadcaster_user_login: 'yamada_hanako',
    viewers: 25,
  }

  it('当てはまるトリガーのアナウンスを、差し込み語を置き換えて色ごと返す', () => {
    const config = 設定([
      { kind: 'raid', actions: [{ type: 'announce', message: '{user} さんが {viewers} 人で来てくれました', color: 'purple' }] },
    ])

    expect(announcementsFor(config, 'channel.raid', レイドの通知, 初回ではない, null)).toEqual([{
      type: 'announce',
      message: '山田花子 さんが 25 人で来てくれました',
      color: 'purple',
    }])
  })

  it('アナウンスを送る動作を持たないトリガー（チャットに送るだけ）には反応しない', () => {
    const チャットだけ: StoredTrigger = { kind: 'raid', actions: [{ type: 'chat', message: 'レイドありがとう' }] }

    expect(announcementsFor(設定([チャットだけ]), 'channel.raid', レイドの通知, 初回ではない, null)).toEqual([])
  })

  it('当てはまるトリガーがなければ null を返す', () => {
    const config = 設定([{ kind: 'follow', actions: [{ type: 'announce', message: 'ありがとう', color: 'primary' }] }])

    expect(announcementsFor(config, 'channel.raid', レイドの通知, 初回ではない, null)).toEqual([])
  })
})

describe('shoutoutsFor', () => {
  const 設定 = (triggers: StoredTrigger[]): AlertConfig => ({ triggers })
  const レイドの通知 = {
    from_broadcaster_user_id: 'レイド元のユーザーID',
    from_broadcaster_user_name: '山田花子',
    from_broadcaster_user_login: 'yamada_hanako',
    viewers: 25,
  }

  it('当てはまるトリガーのシャウトアウトを、紹介する相手ごと返す', () => {
    const config = 設定([{ kind: 'raid', actions: [{ type: 'shoutout' }] }])

    expect(shoutoutsFor(config, 'channel.raid', レイドの通知, 初回ではない)).toEqual([
      { userId: 'レイド元のユーザーID', userLogin: 'yamada_hanako' },
    ])
  })

  it('シャウトアウトを送る動作を持たないトリガー（チャットに送るだけ）には反応しない', () => {
    const チャットだけ: StoredTrigger = { kind: 'raid', actions: [{ type: 'chat', message: 'レイドありがとう' }] }

    expect(shoutoutsFor(設定([チャットだけ]), 'channel.raid', レイドの通知, 初回ではない)).toEqual([])
  })

  it('レイド以外のイベントのトリガーには反応しない', () => {
    const config = 設定([{ kind: 'raid', actions: [{ type: 'shoutout' }] }])

    expect(shoutoutsFor(config, 'channel.follow', { user_name: '田中太郎', user_login: 'tanaka_taro' }, 初回ではない)).toEqual([])
  })
})

describe('firstChatOfStream の条件', () => {
  const 発言した = { event: CHAT_MESSAGE, userName: '田中太郎', userLogin: 'tanaka_taro', text: 'おはようございます' } as const
  const 初回のトリガー = resolveTrigger({ kind: 'welcome', actions: [{ type: 'chat', message: '{user} さん、おかえりなさい！' }] })

  it('その配信で初めての発言なら当てはまる', () => {
    expect(matches(初回のトリガー, 発言した, 初回である)).toBe(true)
  })

  it('その配信で2回目以降の発言なら当てはまらない', () => {
    expect(matches(初回のトリガー, 発言した, 初回ではない)).toBe(false)
  })

  it('チャットの発言以外には当てはまらない（既定メニューからは作れない組み合わせだが、照合でも通さない）', () => {
    const フォローに初回: ResolvedTrigger = {
      kind: 'follow',
      event: 'channel.follow',
      conditions: [{ kind: 'firstChatOfStream' }],
      actions: [{ type: 'chat', message: 'ありがとう' }],
    }
    const フォローした = { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' } as const

    expect(matches(フォローに初回, フォローした, 初回である)).toBe(false)
  })
})

describe('firstChatEver の条件', () => {
  const 発言した = { event: CHAT_MESSAGE, userName: '田中太郎', userLogin: 'tanaka_taro', text: 'はじめまして' } as const
  const 初見のトリガー = resolveTrigger({ kind: 'newViewer', actions: [{ type: 'chat', message: '{user} さん、はじめまして！' }] })

  it('このチャンネルで初めての発言なら当てはまる', () => {
    expect(matches(初見のトリガー, 発言した, { ...初回ではない, firstChatEver: true, daysSinceLastChat: null })).toBe(true)
  })

  it('記録のある人（2回目以降）の発言なら当てはまらない', () => {
    expect(matches(初見のトリガー, 発言した, 初回ではない)).toBe(false)
  })

  it('チャットの発言以外には当てはまらない（既定メニューからは作れない組み合わせだが、照合でも通さない）', () => {
    const フォローに初見: ResolvedTrigger = {
      kind: 'follow',
      event: 'channel.follow',
      conditions: [{ kind: 'firstChatEver' }],
      actions: [{ type: 'chat', message: 'ありがとう' }],
    }
    const フォローした = { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' } as const

    expect(matches(フォローに初見, フォローした, { ...初回ではない, firstChatEver: true })).toBe(false)
  })
})

describe('returningAfter の条件', () => {
  const 発言した = { event: CHAT_MESSAGE, userName: '田中太郎', userLogin: 'tanaka_taro', text: 'おひさしぶりです' } as const
  const 久しぶりのトリガー = resolveTrigger({ kind: 'comeback', days: 30, actions: [{ type: 'chat', message: '{user} さん、お久しぶりです！' }] })

  it('指定した日数ちょうど空いていれば当てはまる', () => {
    expect(matches(久しぶりのトリガー, 発言した, { ...初回ではない, daysSinceLastChat: 30 })).toBe(true)
  })

  it('指定した日数より長く空いていれば当てはまる', () => {
    expect(matches(久しぶりのトリガー, 発言した, { ...初回ではない, daysSinceLastChat: 45.5 })).toBe(true)
  })

  it('指定した日数に足りなければ当てはまらない', () => {
    expect(matches(久しぶりのトリガー, 発言した, { ...初回ではない, daysSinceLastChat: 29.9 })).toBe(false)
  })

  it('このチャンネルで初めての発言（空いた日数が決まらない）には当てはまらない', () => {
    expect(matches(久しぶりのトリガー, 発言した, { firstChatOfStream: true, firstChatEver: true, daysSinceLastChat: null })).toBe(false)
  })

  it('チャットの発言以外には当てはまらない（既定メニューからは作れない組み合わせだが、照合でも通さない）', () => {
    const レイドに久しぶり: ResolvedTrigger = {
      kind: 'raid',
      event: 'channel.raid',
      conditions: [{ kind: 'returningAfter', days: 30 }],
      actions: [{ type: 'chat', message: 'ありがとう' }],
    }
    const レイドされた = { event: 'channel.raid', userId: 'レイド元のユーザーID', userName: '田中太郎', userLogin: 'tanaka_taro', viewers: 10 } as const

    expect(matches(レイドに久しぶり, レイドされた, { ...初回ではない, daysSinceLastChat: 40 })).toBe(false)
  })
})

describe('requiresChatHistory', () => {
  const 初見のトリガー: StoredTrigger = { kind: 'newViewer', actions: [{ type: 'chat', message: 'はじめまして' }] }
  const 久しぶりのトリガー: StoredTrigger = {
    kind: 'comeback', days: 30,
    actions: [{ type: 'chat', message: 'お久しぶりです' }],
  }
  /** 視聴者の記録を見なくても判定できる条件だけを持つトリガー */
  const 記録を見ないトリガー: StoredTrigger = {
    kind: 'welcome',
    actions: [{ type: 'chat', message: 'おかえりなさい' }],
  }

  it('そのイベントに firstChatEver の条件を持つトリガーがあれば true', () => {
    expect(requiresChatHistory({ triggers: [記録を見ないトリガー, 初見のトリガー] }, CHAT_MESSAGE)).toBe(true)
  })

  it('そのイベントに returningAfter の条件を持つトリガーがあれば true', () => {
    expect(requiresChatHistory({ triggers: [久しぶりのトリガー] }, CHAT_MESSAGE)).toBe(true)
  })

  it('どちらの条件も持つトリガーが1件もなければ false（データベースを触らずに済ませるため）', () => {
    expect(requiresChatHistory({ triggers: [記録を見ないトリガー] }, CHAT_MESSAGE)).toBe(false)
  })

  it('別のイベントの通知では false', () => {
    expect(requiresChatHistory({ triggers: [初見のトリガー] }, 'channel.follow')).toBe(false)
  })
})

describe('requiresFirstChatOfStream', () => {
  const 初回のトリガー: StoredTrigger = {
    kind: 'welcome',
    actions: [{ type: 'chat', message: 'おかえりなさい！' }],
  }
  const 条件なしのトリガー: StoredTrigger = { kind: 'everyMessage', actions: [{ type: 'chat', message: 'どうも' }] }

  it('そのイベントに firstChatOfStream の条件を持つトリガーがあれば true', () => {
    expect(requiresFirstChatOfStream({ triggers: [条件なしのトリガー, 初回のトリガー] }, CHAT_MESSAGE)).toBe(true)
  })

  it('その条件を持つトリガーが1件もなければ false（データベースを触らずに済ませるため）', () => {
    expect(requiresFirstChatOfStream({ triggers: [条件なしのトリガー] }, CHAT_MESSAGE)).toBe(false)
  })

  it('別のイベントの通知では false', () => {
    expect(requiresFirstChatOfStream({ triggers: [初回のトリガー] }, 'channel.follow')).toBe(false)
  })
})

describe('requiresStreamSummary', () => {
  const あらすじを使うトリガー: StoredTrigger = {
    kind: 'everyMessage',
    actions: [{ type: 'chat', message: 'これまでのあらすじ: {summary}' }],
  }
  const あらすじを使わないトリガー: StoredTrigger = { kind: 'everyMessage', actions: [{ type: 'chat', message: 'どうも' }] }

  it('そのイベントに {summary} を含む文言を持つトリガーがあれば true', () => {
    expect(requiresStreamSummary({ triggers: [あらすじを使わないトリガー, あらすじを使うトリガー] }, CHAT_MESSAGE)).toBe(true)
  })

  it('アラートの文言（オーバーレイに出す文言）に含まれていても true', () => {
    const アラートの文言: StoredTrigger = {
      kind: 'everyMessage',
      actions: [{ type: 'alert', mediaId: '素材ID', mediaKind: 'image', durationSeconds: 5, volume: 1, message: '{summary}' }],
    }

    expect(requiresStreamSummary({ triggers: [アラートの文言] }, CHAT_MESSAGE)).toBe(true)
  })

  it('アナウンスの文言に含まれていても true', () => {
    const アナウンスの文言: StoredTrigger = {
      kind: 'everyMessage',
      actions: [{ type: 'announce', message: '{summary}', color: 'blue' }],
    }

    expect(requiresStreamSummary({ triggers: [アナウンスの文言] }, CHAT_MESSAGE)).toBe(true)
  })

  it('{summary} を使う文言が1件もなければ false（データベースを触らずに済ませるため）', () => {
    expect(requiresStreamSummary({ triggers: [あらすじを使わないトリガー] }, CHAT_MESSAGE)).toBe(false)
  })

  it('文面をLLMに作らせる動作（aiChat）があれば、文言に書かれていなくても true（あらすじも材料にするため）', () => {
    const LLMに作らせる: StoredTrigger = {
      kind: 'everyMessage',
      actions: [{ type: 'aiChat', instruction: '話の流れに合わせて返してください' }],
    }

    expect(requiresStreamSummary({ triggers: [LLMに作らせる] }, CHAT_MESSAGE)).toBe(true)
  })

  it('別のイベントの通知では false', () => {
    expect(requiresStreamSummary({ triggers: [あらすじを使うトリガー] }, 'channel.follow')).toBe(false)
  })
})

describe('hasAlertAction', () => {
  const アラートのトリガー: StoredTrigger = {
    kind: 'everyMessage',
    actions: [{ type: 'alert', mediaId: '素材ID', mediaKind: 'image', durationSeconds: 5, volume: 1, message: 'ありがとう' }],
  }
  const チャットだけのトリガー: StoredTrigger = { kind: 'everyMessage', actions: [{ type: 'chat', message: 'どうも' }] }

  it('そのイベントにアラートを出す動作を持つトリガーがあれば true', () => {
    expect(hasAlertAction({ triggers: [チャットだけのトリガー, アラートのトリガー] }, CHAT_MESSAGE)).toBe(true)
  })

  it('アラートを出す動作が1件もなければ false（オーバーレイ用キーを読みに行かずに済ませるため）', () => {
    expect(hasAlertAction({ triggers: [チャットだけのトリガー] }, CHAT_MESSAGE)).toBe(false)
  })

  it('別のイベントの通知では false', () => {
    expect(hasAlertAction({ triggers: [アラートのトリガー] }, 'channel.follow')).toBe(false)
  })
})

describe('alertsFor', () => {
  it('当てはまるトリガーが複数あれば、並びの順にすべてのアラートを返す（オーバーレイが順に再生する）', () => {
    const 二件: AlertConfig = {
      triggers: [
        { kind: 'newViewer', actions: [{ ...アラートの動作, message: 'はじめまして' }] },
        { kind: 'everyMessage', actions: [{ ...アラートの動作, message: 'どうも' }] },
      ],
    }
    const 発言 = {
      broadcaster_user_id: '配信者ID',
      chatter_user_id: '発言者ID',
      chatter_user_login: 'tanaka_taro',
      chatter_user_name: '田中太郎',
      message_id: '発言ID-1',
      message: { text: 'こんにちは' },
    }

    expect(alertsFor(二件, CHAT_MESSAGE, 発言, オーバーレイ用キー, { ...初回ではない, firstChatEver: true }, null).map((alert) => alert.text)).toEqual([
      'はじめまして',
      'どうも',
    ])
  })

  const オーバーレイ用キー = 'overlay-key_1'
  const フォローの通知 = { user_name: '田中太郎', user_login: 'tanaka_taro' }
  const アラートの動作 = {
    type: 'alert',
    mediaId: '素材ID-乾杯の動画',
    mediaKind: 'video',
    durationSeconds: 8,
    volume: 0.5,
    message: '{user} さん、ありがとう！',
  } as const

  it('当てはまるトリガーのアラートを、素材のURLと差し込み後の文言で返す', () => {
    const config: AlertConfig = { triggers: [{ kind: 'follow', actions: [アラートの動作] }] }

    expect(alertsFor(config, 'channel.follow', フォローの通知, オーバーレイ用キー, 初回ではない, null)).toEqual([{
      media: { kind: 'video', url: '/api/media/%E7%B4%A0%E6%9D%90ID-%E4%B9%BE%E6%9D%AF%E3%81%AE%E5%8B%95%E7%94%BB?key=overlay-key_1' },
      durationSeconds: 8,
      volume: 0.5,
      text: '田中太郎 さん、ありがとう！',
    }])
  })

  it('画面に出す文言の {summary} に、渡された配信のあらすじを差し込む', () => {
    const あらすじを出す = { ...アラートの動作, message: 'これまでのあらすじ: {summary}' }
    const config: AlertConfig = { triggers: [{ kind: 'follow', actions: [あらすじを出す] }] }

    expect(alertsFor(config, 'channel.follow', フォローの通知, オーバーレイ用キー, 初回ではない, '新しいゲームを遊んでいます')[0]?.text).toBe(
      'これまでのあらすじ: 新しいゲームを遊んでいます',
    )
  })

  it('アラートを出す動作を持たないトリガー（チャットに送るだけ）には反応しない', () => {
    const config: AlertConfig = { triggers: [{ kind: 'follow', actions: [{ type: 'chat', message: 'ありがとう' }] }] }

    expect(alertsFor(config, 'channel.follow', フォローの通知, オーバーレイ用キー, 初回ではない, null)).toEqual([])
  })

  it('当てはまるトリガーがなければ null を返す', () => {
    const config: AlertConfig = { triggers: [{ kind: 'raid', actions: [アラートの動作] }] }

    expect(alertsFor(config, 'channel.follow', フォローの通知, オーバーレイ用キー, 初回ではない, null)).toEqual([])
  })

  it('firstChatOfStream の条件を持つトリガーは、その配信で初めての発言のときだけ再生する', () => {
    const 発言の通知 = {
      broadcaster_user_id: '配信者ID',
      chatter_user_id: '発言者ID',
      chatter_user_login: 'tanaka_taro',
      chatter_user_name: '田中太郎',
      message_id: '発言ID-1',
      message: { text: 'おはようございます' },
    }
    const config: AlertConfig = { triggers: [{ kind: 'welcome', actions: [アラートの動作] }] }

    expect(alertsFor(config, CHAT_MESSAGE, 発言の通知, オーバーレイ用キー, 初回である, null)[0]?.text).toBe('田中太郎 さん、ありがとう！')
    expect(alertsFor(config, CHAT_MESSAGE, 発言の通知, オーバーレイ用キー, 初回ではない, null)).toEqual([])
  })
})
