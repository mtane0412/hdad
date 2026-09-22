/**
 * アラートのイベントの読み取り（alert-event.ts）のテスト
 *
 * Twitchから届いた通知の中身から、条件の照合と文言の差し込みに使う項目を取り出せること、
 * トリガーの一覧から動作（チャットに送る・アナウンスを送る・アラートを出す）を選べることを確認する。
 * 「その配信で初めての発言か」は通知の中身では決まらないので、判定結果（ConditionState）を値で受け取る形になっている。
 */
import { describe, expect, it } from 'vitest'
import type { AlertConfig, StoredCondition, StoredTrigger } from './alert-config'
import { alertFor, announcementFor, chatMessageFor, extract, fillMessage, hasAlertAction, matches, requiresFirstChatOfStream, type ConditionState } from './alert-event'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
const CHAT_MESSAGE = 'channel.chat.message'

/** 通知の中身だけでは決まらない条件の判定結果。この一群のテストではふだんの発言（その配信で2回目以降）として扱う */
const 初回ではない: ConditionState = { firstChatOfStream: false }
/** その配信で初めての発言だった場合の判定結果 */
const 初回である: ConditionState = { firstChatOfStream: true }

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
    const event = { from_broadcaster_user_name: '山田花子', from_broadcaster_user_login: 'yamada_hanako', to_broadcaster_user_name: '配信者本人', viewers: 42 }

    expect(extract('channel.raid', event)).toEqual({ event: 'channel.raid', userName: '山田花子', userLogin: 'yamada_hanako', viewers: 42 })
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

  it('対応していないイベントの種類は null を返す（Twitchが種類を増やしてもWorkerを止めない）', () => {
    expect(extract('channel.cheer', { user_name: '田中太郎' })).toBeNull()
  })

  it('通知の中身が想定と違えば、どの項目が足りないかを示してエラーにする', () => {
    expect(() => extract('channel.follow', { user_login: 'tanaka' })).toThrowError(/user_name/)
    expect(() => extract('channel.raid', { from_broadcaster_user_name: '山田花子', from_broadcaster_user_login: 'yamada_hanako' })).toThrowError(/viewers/)
    expect(() => extract(REDEMPTION, { user_name: '田中太郎', user_login: 'tanaka_taro' })).toThrowError(/reward/)
  })
})

describe('matches', () => {
  /** チャンネルポイント交換のトリガー。条件だけを差し替えて確かめる */
  const 交換のトリガー = (conditions: StoredCondition[]): StoredTrigger => ({
    event: REDEMPTION,
    conditions,
    actions: [{ type: 'chat', message: '乾杯！' }],
  })
  const 交換した = { event: REDEMPTION, userName: '田中太郎', userLogin: 'tanaka_taro', rewardId: '報酬ID-乾杯', rewardTitle: '乾杯する' } as const

  it('イベントの種類が違えば当てはまらない', () => {
    const フォローのトリガー: StoredTrigger = { event: 'channel.follow', conditions: [], actions: [{ type: 'chat', message: 'ありがとう' }] }

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
    const チャットのトリガー = (conditions: StoredCondition[]): StoredTrigger => ({ event: CHAT_MESSAGE, conditions, actions: [{ type: 'chat', message: 'やあ' }] })
    const 発言した = { event: CHAT_MESSAGE, userName: '田中太郎', userLogin: 'tanaka_taro', text: 'みなさんおはようございます' } as const

    expect(matches(チャットのトリガー([{ kind: 'text', contains: 'おはよう' }]), 発言した, 初回ではない)).toBe(true)
    expect(matches(チャットのトリガー([{ kind: 'text', contains: 'こんばんは' }]), 発言した, 初回ではない)).toBe(false)
  })

  it('text の条件は大文字小文字を区別しない', () => {
    const チャットのトリガー: StoredTrigger = { event: CHAT_MESSAGE, conditions: [{ kind: 'text', contains: 'Hello' }], actions: [{ type: 'chat', message: 'やあ' }] }
    const 発言した = { event: CHAT_MESSAGE, userName: '田中太郎', userLogin: 'tanaka_taro', text: 'HELLO everyone' } as const

    expect(matches(チャットのトリガー, 発言した, 初回ではない)).toBe(true)
  })

  it('text の条件はチャットの発言以外には当てはまらない（保存時に拒否するが、照合でも通さない）', () => {
    const フォローに文面: StoredTrigger = { event: 'channel.follow', conditions: [{ kind: 'text', contains: 'おはよう' }], actions: [{ type: 'chat', message: 'ありがとう' }] }
    const フォローした = { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' } as const

    expect(matches(フォローに文面, フォローした, 初回ではない)).toBe(false)
  })

  it('reward の条件はチャンネルポイント交換以外には当てはまらない（保存時に拒否するが、照合でも通さない）', () => {
    const フォローに報酬: StoredTrigger = { event: 'channel.follow', conditions: [{ kind: 'reward', rewardId: '報酬ID-乾杯' }], actions: [{ type: 'chat', message: 'ありがとう' }] }
    const フォローした = { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' } as const

    expect(matches(フォローに報酬, フォローした, 初回ではない)).toBe(false)
  })
})

describe('fillMessage', () => {
  it('イベントごとの差し込み語を値に置き換える', () => {
    const 継続サブスク = { event: 'channel.subscription.message', userName: '田中太郎', userLogin: 'tanaka_taro', tier: '2000', cumulativeMonths: 12 } as const

    expect(fillMessage('{user} さん、ティア{tier}で{months}か月ありがとう！', 継続サブスク)).toBe('田中太郎 さん、ティア2で12か月ありがとう！')
  })

  it('そのイベントにない差し込み語は残す（入力の誤りに配信者が気付けるようにする）', () => {
    expect(fillMessage('{user} さん、{viewers}人', { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' })).toBe('田中太郎 さん、{viewers}人')
  })

  it('チャットの発言では、{message} が本文に置き換わる', () => {
    const 発言した = { event: CHAT_MESSAGE, userName: '田中太郎', userLogin: 'tanaka_taro', text: 'おはよう' } as const

    expect(fillMessage('{user} さんが「{message}」と言いました', 発言した)).toBe('田中太郎 さんが「おはよう」と言いました')
  })

  it('報酬名に $& のような置換の特殊な指定が含まれていても、そのまま差し込む', () => {
    const 交換した = { event: REDEMPTION, userName: '田中太郎', userLogin: 'tanaka_taro', rewardId: '報酬ID', rewardTitle: '$& と $1 の報酬' } as const

    expect(fillMessage('{reward} を交換しました', 交換した)).toBe('$& と $1 の報酬 を交換しました')
  })
})

describe('chatMessageFor', () => {
  const 設定 = (triggers: StoredTrigger[]): AlertConfig => ({ triggers })
  const フォローの通知 = { user_name: '田中太郎', user_login: 'tanaka_taro' }

  it('当てはまるトリガーのチャットの文言を、差し込み語を置き換えて返す', () => {
    const config = 設定([{ event: 'channel.follow', conditions: [], actions: [{ type: 'chat', message: '{user} さん、フォローありがとうございます！' }] }])

    expect(chatMessageFor(config, 'channel.follow', フォローの通知, 初回ではない)).toBe('田中太郎 さん、フォローありがとうございます！')
  })

  it('当てはまるトリガーがなければ null を返す', () => {
    const config = 設定([{ event: 'channel.raid', conditions: [], actions: [{ type: 'chat', message: 'レイドありがとう' }] }])

    expect(chatMessageFor(config, 'channel.follow', フォローの通知, 初回ではない)).toBeNull()
  })

  it('チャットに送る動作を持たないトリガー（アラートを出すだけ）には反応しない', () => {
    const アラートだけ: StoredTrigger = {
      event: 'channel.follow',
      conditions: [],
      actions: [{ type: 'alert', mediaId: '素材ID-拍手の音', mediaKind: 'audio', durationSeconds: 5, volume: 0.5, message: '' }],
    }

    expect(chatMessageFor(設定([アラートだけ]), 'channel.follow', フォローの通知, 初回ではない)).toBeNull()
  })

  it('複数のトリガーが当てはまる場合は、先に書かれたものを使う（チャットを連投しない）', () => {
    const config = 設定([
      { event: 'channel.follow', conditions: [], actions: [{ type: 'chat', message: '1つ目の文言' }] },
      { event: 'channel.follow', conditions: [], actions: [{ type: 'chat', message: '2つ目の文言' }] },
    ])

    expect(chatMessageFor(config, 'channel.follow', フォローの通知, 初回ではない)).toBe('1つ目の文言')
  })

  it('チャットに送るトリガーがないイベントなら、通知の中身が想定と違ってもエラーにしない（設定していないイベントで止めない）', () => {
    const config = 設定([{ event: 'channel.raid', conditions: [], actions: [{ type: 'chat', message: 'レイドありがとう' }] }])

    expect(chatMessageFor(config, 'channel.follow', { user_login: 'tanaka' }, 初回ではない)).toBeNull()
  })

  it('対応していないイベントの種類なら null を返す', () => {
    const config = 設定([{ event: 'channel.follow', conditions: [], actions: [{ type: 'chat', message: 'ありがとう' }] }])

    expect(chatMessageFor(config, 'stream.online', { id: '配信ID' }, 初回ではない)).toBeNull()
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
      triggers: [{ event: CHAT_MESSAGE, conditions: [{ kind: 'text', contains: 'おはよう' }], actions: [{ type: 'chat', message: '{user} さん、おはよう！' }] }],
    }

    expect(chatMessageFor(設定, CHAT_MESSAGE, 発言の通知, 初回ではない)).toBe('田中太郎 さん、おはよう！')
  })

  it('発言者の条件に当てはまらない発言では null を返す', () => {
    const 設定: AlertConfig = {
      triggers: [{ event: CHAT_MESSAGE, conditions: [{ kind: 'user', login: 'yamada_hanako' }], actions: [{ type: 'chat', message: 'やあ' }] }],
    }

    expect(chatMessageFor(設定, CHAT_MESSAGE, 発言の通知, 初回ではない)).toBeNull()
  })

  it('本文を差し込んでTwitchの上限（500文字）を超えたら、末尾を … にして収める', () => {
    const 長い発言 = {
      ...発言の通知,
      message: { text: 'あ'.repeat(500) },
    }
    const 設定: AlertConfig = {
      triggers: [{ event: CHAT_MESSAGE, conditions: [], actions: [{ type: 'chat', message: '{user} さんの発言: {message}' }] }],
    }

    const 送る文言 = chatMessageFor(設定, CHAT_MESSAGE, 長い発言, 初回ではない)

    expect(送る文言).toHaveLength(500)
    expect(送る文言?.endsWith('…')).toBe(true)
    expect(送る文言?.startsWith('田中太郎 さんの発言: ')).toBe(true)
  })

  it('アナウンスの文言も、Twitchの上限（500文字）に収める', () => {
    const 長い発言 = { ...発言の通知, message: { text: 'あ'.repeat(500) } }
    const 設定: AlertConfig = {
      triggers: [{ event: CHAT_MESSAGE, conditions: [], actions: [{ type: 'announce', message: '{message}', color: 'blue' }] }],
    }

    expect(announcementFor(設定, CHAT_MESSAGE, 長い発言, 初回ではない)?.message).toHaveLength(500)
  })

  it('発言の本文をアナウンスの文言に差し込める', () => {
    const 設定: AlertConfig = {
      triggers: [
        {
          event: CHAT_MESSAGE,
          conditions: [{ kind: 'text', contains: 'おはよう' }],
          actions: [{ type: 'announce', message: '{user}: {message}', color: 'blue' }],
        },
      ],
    }

    expect(announcementFor(設定, CHAT_MESSAGE, 発言の通知, 初回ではない)).toEqual({ type: 'announce', message: '田中太郎: みなさんおはようございます', color: 'blue' })
  })
})

describe('announcementFor', () => {
  const 設定 = (triggers: StoredTrigger[]): AlertConfig => ({ triggers })
  const レイドの通知 = { from_broadcaster_user_name: '山田花子', from_broadcaster_user_login: 'yamada_hanako', viewers: 25 }

  it('当てはまるトリガーのアナウンスを、差し込み語を置き換えて色ごと返す', () => {
    const config = 設定([
      { event: 'channel.raid', conditions: [], actions: [{ type: 'announce', message: '{user} さんが {viewers} 人で来てくれました', color: 'purple' }] },
    ])

    expect(announcementFor(config, 'channel.raid', レイドの通知, 初回ではない)).toEqual({
      type: 'announce',
      message: '山田花子 さんが 25 人で来てくれました',
      color: 'purple',
    })
  })

  it('アナウンスを送る動作を持たないトリガー（チャットに送るだけ）には反応しない', () => {
    const チャットだけ: StoredTrigger = { event: 'channel.raid', conditions: [], actions: [{ type: 'chat', message: 'レイドありがとう' }] }

    expect(announcementFor(設定([チャットだけ]), 'channel.raid', レイドの通知, 初回ではない)).toBeNull()
  })

  it('当てはまるトリガーがなければ null を返す', () => {
    const config = 設定([{ event: 'channel.follow', conditions: [], actions: [{ type: 'announce', message: 'ありがとう', color: 'primary' }] }])

    expect(announcementFor(config, 'channel.raid', レイドの通知, 初回ではない)).toBeNull()
  })
})

describe('firstChatOfStream の条件', () => {
  const 発言した = { event: CHAT_MESSAGE, userName: '田中太郎', userLogin: 'tanaka_taro', text: 'おはようございます' } as const
  const 初回のトリガー: StoredTrigger = {
    event: CHAT_MESSAGE,
    conditions: [{ kind: 'firstChatOfStream' }],
    actions: [{ type: 'chat', message: '{user} さん、おかえりなさい！' }],
  }

  it('その配信で初めての発言なら当てはまる', () => {
    expect(matches(初回のトリガー, 発言した, 初回である)).toBe(true)
  })

  it('その配信で2回目以降の発言なら当てはまらない', () => {
    expect(matches(初回のトリガー, 発言した, 初回ではない)).toBe(false)
  })

  it('チャットの発言以外には当てはまらない（保存時に拒否するが、照合でも通さない）', () => {
    const フォローに初回: StoredTrigger = {
      event: 'channel.follow',
      conditions: [{ kind: 'firstChatOfStream' }],
      actions: [{ type: 'chat', message: 'ありがとう' }],
    }
    const フォローした = { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' } as const

    expect(matches(フォローに初回, フォローした, 初回である)).toBe(false)
  })

  it('ほかの条件と組み合わせると、両方を満たしたときだけ当てはまる（and）', () => {
    const 初回かつ文面: StoredTrigger = {
      ...初回のトリガー,
      conditions: [{ kind: 'firstChatOfStream' }, { kind: 'text', contains: 'おはよう' }],
    }

    expect(matches(初回かつ文面, 発言した, 初回である)).toBe(true)
    expect(matches(初回かつ文面, { ...発言した, text: 'こんばんは' }, 初回である)).toBe(false)
  })
})

describe('requiresFirstChatOfStream', () => {
  const 初回のトリガー: StoredTrigger = {
    event: CHAT_MESSAGE,
    conditions: [{ kind: 'firstChatOfStream' }],
    actions: [{ type: 'chat', message: 'おかえりなさい！' }],
  }
  const 条件なしのトリガー: StoredTrigger = { event: CHAT_MESSAGE, conditions: [], actions: [{ type: 'chat', message: 'どうも' }] }

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

describe('hasAlertAction', () => {
  const アラートのトリガー: StoredTrigger = {
    event: CHAT_MESSAGE,
    conditions: [],
    actions: [{ type: 'alert', mediaId: '素材ID', mediaKind: 'image', durationSeconds: 5, volume: 1, message: 'ありがとう' }],
  }
  const チャットだけのトリガー: StoredTrigger = { event: CHAT_MESSAGE, conditions: [], actions: [{ type: 'chat', message: 'どうも' }] }

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

describe('alertFor', () => {
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
    const config: AlertConfig = { triggers: [{ event: 'channel.follow', conditions: [], actions: [アラートの動作] }] }

    expect(alertFor(config, 'channel.follow', フォローの通知, オーバーレイ用キー, 初回ではない)).toEqual({
      media: { kind: 'video', url: '/api/media/%E7%B4%A0%E6%9D%90ID-%E4%B9%BE%E6%9D%AF%E3%81%AE%E5%8B%95%E7%94%BB?key=overlay-key_1' },
      durationSeconds: 8,
      volume: 0.5,
      text: '田中太郎 さん、ありがとう！',
    })
  })

  it('アラートを出す動作を持たないトリガー（チャットに送るだけ）には反応しない', () => {
    const config: AlertConfig = { triggers: [{ event: 'channel.follow', conditions: [], actions: [{ type: 'chat', message: 'ありがとう' }] }] }

    expect(alertFor(config, 'channel.follow', フォローの通知, オーバーレイ用キー, 初回ではない)).toBeNull()
  })

  it('当てはまるトリガーがなければ null を返す', () => {
    const config: AlertConfig = { triggers: [{ event: 'channel.raid', conditions: [], actions: [アラートの動作] }] }

    expect(alertFor(config, 'channel.follow', フォローの通知, オーバーレイ用キー, 初回ではない)).toBeNull()
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
    const config: AlertConfig = { triggers: [{ event: CHAT_MESSAGE, conditions: [{ kind: 'firstChatOfStream' }], actions: [アラートの動作] }] }

    expect(alertFor(config, CHAT_MESSAGE, 発言の通知, オーバーレイ用キー, 初回である)?.text).toBe('田中太郎 さん、ありがとう！')
    expect(alertFor(config, CHAT_MESSAGE, 発言の通知, オーバーレイ用キー, 初回ではない)).toBeNull()
  })
})
