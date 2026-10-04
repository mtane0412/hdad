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
  townToursFor,
  type ConditionState,
} from './alert-event'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
const CHAT_MESSAGE = 'channel.chat.message'
const AD_BREAK_BEGIN = 'channel.ad_break.begin'
const AD_BREAK_END = 'channel.ad_break.end'

/** Twitchから届く広告の開始の通知の中身。自動で入った3分の広告を表す */
const adNotification = {
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
const notFirstTime: ConditionState = { firstChatOfStream: false, firstChatEver: false, daysSinceLastChat: 0 }
/** その配信で初めての発言だった場合の判定結果 */
const isFirstTime: ConditionState = { firstChatOfStream: true, firstChatEver: false, daysSinceLastChat: 3 }

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
    expect(extract(AD_BREAK_BEGIN, adNotification)).toEqual({
      event: AD_BREAK_BEGIN,
      userName: 'たねのぶ',
      userLogin: 'tanenobu',
      durationSeconds: 180,
      automatic: true,
    })
  })

  it('広告の終了も開始と同じ中身から取り出す（終了はWorkerが同じ中身で作る擬似イベントなので）', () => {
    expect(extract(AD_BREAK_END, adNotification)).toEqual({
      event: AD_BREAK_END,
      userName: 'たねのぶ',
      userLogin: 'tanenobu',
      durationSeconds: 180,
      automatic: true,
    })
  })

  it('GitHub のpushから、pushした人・リポジトリ・ブランチ・最後のコミットのメッセージの1行目を取り出す', () => {
    // push の通知では sender が省略されうるので、必ずある pusher.name（pushした人の GitHub のユーザー名）を読む
    const payload = {
      ref: 'refs/heads/feature/github-webhook',
      pusher: { name: 'mtane0412', email: 'mtane0412@example.com' },
      repository: { name: 'hdad', full_name: 'mtane0412/hdad' },
      head_commit: { message: 'GitHub の Webhook を受ける口を足す\n\n本文の2行目以降は配信に出さない' },
    }

    expect(extract('github.push', payload)).toEqual({
      event: 'github.push',
      userName: 'mtane0412',
      userLogin: 'mtane0412',
      repository: 'hdad',
      branch: 'feature/github-webhook',
      commitMessage: 'GitHub の Webhook を受ける口を足す',
    })
  })

  it('GitHub のPRのマージから、マージした人・リポジトリ・PRのタイトルと番号を取り出す', () => {
    const payload = {
      action: 'closed',
      sender: { login: 'mtane0412' },
      repository: { name: 'hdad', full_name: 'mtane0412/hdad' },
      pull_request: { number: 212, title: 'コミットとPRのマージをトリガーのきっかけにする', merged: true },
    }

    expect(extract('github.pull_request.merged', payload)).toEqual({
      event: 'github.pull_request.merged',
      userName: 'mtane0412',
      userLogin: 'mtane0412',
      repository: 'hdad',
      title: 'コミットとPRのマージをトリガーのきっかけにする',
      number: 212,
    })
  })

  it('GitHub の通知の中身が想定と違えば、どの項目が足りないかを示してエラーにする', () => {
    expect(() => extract('github.push', { ref: 'refs/heads/main', pusher: { name: 'mtane0412' }, repository: { name: 'hdad' } })).toThrowError(/head_commit/)
    expect(() => extract('github.push', { ref: 'refs/heads/main', repository: { name: 'hdad' }, head_commit: { message: '直す' } })).toThrowError(/pusher/)
    expect(() => extract('github.pull_request.merged', { sender: { login: 'mtane0412' }, repository: { name: 'hdad' } })).toThrowError(/pull_request/)
  })

  it('ポモドーロの区切りから、何本目かと区間の長さ（分）を取り出す', () => {
    // Twitchの通知ではなく、Workerのタイマー（worker/pomodoro-timer.ts）が作る中身である
    expect(extract('hdad.pomodoro.work_begin', { round: 2, minutes: 25 })).toEqual({ event: 'hdad.pomodoro.work_begin', round: 2, minutes: 25 })
    expect(extract('hdad.pomodoro.break_begin', { round: 2, minutes: 5 })).toEqual({ event: 'hdad.pomodoro.break_begin', round: 2, minutes: 5 })
  })

  it('ポモドーロの区切りの中身が想定と違えば、どの項目が足りないかを示してエラーにする', () => {
    expect(() => extract('hdad.pomodoro.work_begin', { minutes: 25 })).toThrowError(/round/)
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
  const redeemTrigger = (conditions: StoredCondition[]): ResolvedTrigger => ({
    kind: 'reward',
    event: REDEMPTION,
    conditions,
    actions: [{ type: 'chat', message: '乾杯！' }],
  })
  const redeemed = { event: REDEMPTION, userName: '田中太郎', userLogin: 'tanaka_taro', rewardId: '報酬ID-乾杯', rewardTitle: '乾杯する' } as const

  it('イベントの種類が違えば当てはまらない', () => {
    const followTrigger: ResolvedTrigger = { kind: 'follow', event: 'channel.follow', conditions: [], actions: [{ type: 'chat', message: 'ありがとう' }] }

    expect(matches(followTrigger, redeemed, notFirstTime)).toBe(false)
  })

  it('条件が1件もないトリガーは、そのイベントならいつでも当てはまる', () => {
    expect(matches(redeemTrigger([]), redeemed, notFirstTime)).toBe(true)
  })

  it('reward の条件は、報酬IDが同じときだけ当てはまる', () => {
    expect(matches(redeemTrigger([{ kind: 'reward', rewardId: '報酬ID-乾杯' }]), redeemed, notFirstTime)).toBe(true)
    expect(matches(redeemTrigger([{ kind: 'reward', rewardId: '報酬ID-別の報酬' }]), redeemed, notFirstTime)).toBe(false)
  })

  it('user の条件は、相手のユーザー名が同じときだけ当てはまる', () => {
    expect(matches(redeemTrigger([{ kind: 'user', login: 'tanaka_taro' }]), redeemed, notFirstTime)).toBe(true)
    expect(matches(redeemTrigger([{ kind: 'user', login: 'yamada_hanako' }]), redeemed, notFirstTime)).toBe(false)
  })

  it('user の条件は大文字小文字を区別しない（Twitchのユーザー名は小文字だが、配信者が表示名の綴りで入れても当てる）', () => {
    expect(matches(redeemTrigger([{ kind: 'user', login: 'Tanaka_Taro' }]), redeemed, notFirstTime)).toBe(true)
  })

  it('user の条件は、相手のいないポモドーロの区切りでは満たさない', () => {
    const pomodoroTrigger: ResolvedTrigger = {
      kind: 'pomodoroBreakBegin',
      event: 'hdad.pomodoro.break_begin',
      conditions: [{ kind: 'user', login: 'tanaka_taro' }],
      actions: [{ type: 'chat', message: '休憩です' }],
    }

    expect(matches(pomodoroTrigger, { event: 'hdad.pomodoro.break_begin', round: 1, minutes: 5 }, notFirstTime)).toBe(false)
  })

  it('条件が2つあれば、すべてを満たしたときだけ当てはまる（and）', () => {
    const bothRewardAndUser: StoredCondition[] = [
      { kind: 'reward', rewardId: '報酬ID-乾杯' },
      { kind: 'user', login: 'tanaka_taro' },
    ]
    const onlyRewardMatches: StoredCondition[] = [
      { kind: 'reward', rewardId: '報酬ID-乾杯' },
      { kind: 'user', login: 'yamada_hanako' },
    ]

    expect(matches(redeemTrigger(bothRewardAndUser), redeemed, notFirstTime)).toBe(true)
    expect(matches(redeemTrigger(onlyRewardMatches), redeemed, notFirstTime)).toBe(false)
  })

  it('text の条件は、本文にその文字を含むときだけ当てはまる（部分一致）', () => {
    const chatTrigger = (conditions: StoredCondition[]): ResolvedTrigger => ({ kind: 'everyMessage', event: CHAT_MESSAGE, conditions, actions: [{ type: 'chat', message: 'やあ' }] })
    const chatted = { event: CHAT_MESSAGE, userName: '田中太郎', userLogin: 'tanaka_taro', text: 'みなさんおはようございます' } as const

    expect(matches(chatTrigger([{ kind: 'text', contains: 'おはよう' }]), chatted, notFirstTime)).toBe(true)
    expect(matches(chatTrigger([{ kind: 'text', contains: 'こんばんは' }]), chatted, notFirstTime)).toBe(false)
  })

  it('text の条件は大文字小文字を区別しない', () => {
    const chatTrigger: ResolvedTrigger = { kind: 'everyMessage', event: CHAT_MESSAGE, conditions: [{ kind: 'text', contains: 'Hello' }], actions: [{ type: 'chat', message: 'やあ' }] }
    const chatted = { event: CHAT_MESSAGE, userName: '田中太郎', userLogin: 'tanaka_taro', text: 'HELLO everyone' } as const

    expect(matches(chatTrigger, chatted, notFirstTime)).toBe(true)
  })

  it('text の条件はチャットの発言以外には当てはまらない（既定メニューからは作れない組み合わせだが、照合でも通さない）', () => {
    const followWithMessage: ResolvedTrigger = { kind: 'follow', event: 'channel.follow', conditions: [{ kind: 'text', contains: 'おはよう' }], actions: [{ type: 'chat', message: 'ありがとう' }] }
    const followed = { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' } as const

    expect(matches(followWithMessage, followed, notFirstTime)).toBe(false)
  })

  it('automatic の条件は、広告が自動で入ったかどうかが一致するときだけ当てはまる', () => {
    const adTrigger = (conditions: StoredCondition[]): ResolvedTrigger => ({ kind: 'adBreakBegin', event: AD_BREAK_BEGIN, conditions, actions: [{ type: 'chat', message: '広告です' }] })
    const autoJoined = { event: AD_BREAK_BEGIN, userName: 'たねのぶ', userLogin: 'tanenobu', durationSeconds: 180, automatic: true } as const

    expect(matches(adTrigger([{ kind: 'automatic', automatic: true }]), autoJoined, notFirstTime)).toBe(true)
    expect(matches(adTrigger([{ kind: 'automatic', automatic: false }]), autoJoined, notFirstTime)).toBe(false)
  })

  it('automatic の条件は広告以外には当てはまらない（既定メニューからは作れない組み合わせだが、照合でも通さない）', () => {
    const followWithAutoFlag: ResolvedTrigger = {
      kind: 'follow',
      event: 'channel.follow',
      conditions: [{ kind: 'automatic', automatic: true }],
      actions: [{ type: 'chat', message: 'ありがとう' }],
    }
    const followed = { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' } as const

    expect(matches(followWithAutoFlag, followed, notFirstTime)).toBe(false)
  })

  it('reward の条件はチャンネルポイント交換以外には当てはまらない（既定メニューからは作れない組み合わせだが、照合でも通さない）', () => {
    const followWithReward: ResolvedTrigger = { kind: 'follow', event: 'channel.follow', conditions: [{ kind: 'reward', rewardId: '報酬ID-乾杯' }], actions: [{ type: 'chat', message: 'ありがとう' }] }
    const followed = { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' } as const

    expect(matches(followWithReward, followed, notFirstTime)).toBe(false)
  })
})

describe('fillMessage', () => {
  it('イベントごとの差し込み語を値に置き換える', () => {
    const resubscription = { event: 'channel.subscription.message', userName: '田中太郎', userLogin: 'tanaka_taro', tier: '2000', cumulativeMonths: 12 } as const

    expect(fillMessage('{user} さん、ティア{tier}で{months}か月ありがとう！', resubscription, null)).toBe('田中太郎 さん、ティア2で12か月ありがとう！')
  })

  it('そのイベントにない差し込み語は残す（入力の誤りに配信者が気付けるようにする）', () => {
    expect(fillMessage('{user} さん、{viewers}人', { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' }, null)).toBe('田中太郎 さん、{viewers}人')
  })

  it('チャットの発言では、{message} が本文に置き換わる', () => {
    const chatted = { event: CHAT_MESSAGE, userName: '田中太郎', userLogin: 'tanaka_taro', text: 'おはよう' } as const

    expect(fillMessage('{user} さんが「{message}」と言いました', chatted, null)).toBe('田中太郎 さんが「おはよう」と言いました')
  })

  it('コミットのpushでは、{repo}・{branch}・{message} がリポジトリ名・ブランチ名・コミットのメッセージに置き換わる', () => {
    const pushed = {
      event: 'github.push',
      userName: 'mtane0412',
      userLogin: 'mtane0412',
      repository: 'hdad',
      branch: 'feature/github-webhook',
      commitMessage: 'テストを先に書く',
    } as const

    expect(fillMessage('{repo} の {branch} に「{message}」をpushしました（{user}）', pushed, null)).toBe(
      'hdad の feature/github-webhook に「テストを先に書く」をpushしました（mtane0412）',
    )
  })

  it('ポモドーロの区切りでは、{round}・{minutes} が何本目かと区間の長さ（分）に置き換わる', () => {
    const breakBegan = { event: 'hdad.pomodoro.break_begin', round: 3, minutes: 5 } as const

    expect(fillMessage('{round}本目おつかれさまでした。{minutes}分休憩です', breakBegan, null)).toBe('3本目おつかれさまでした。5分休憩です')
  })

  it('ポモドーロの区切りには相手がいないので、{user} は置き換えずに残す', () => {
    const workBegan = { event: 'hdad.pomodoro.work_begin', round: 1, minutes: 25 } as const

    expect(fillMessage('{user} さん、作業開始です', workBegan, null)).toBe('{user} さん、作業開始です')
  })

  it('PRのマージでは、{title}・{number} がPRのタイトルと番号に置き換わる', () => {
    const merged = { event: 'github.pull_request.merged', userName: 'mtane0412', userLogin: 'mtane0412', repository: 'hdad', title: '字幕を直す', number: 197 } as const

    expect(fillMessage('{repo} #{number}「{title}」をマージしました', merged, null)).toBe('hdad #197「字幕を直す」をマージしました')
  })

  it('広告では、{duration} が広告の長さ（秒）に置き換わる', () => {
    const adStarted = { event: AD_BREAK_BEGIN, userName: 'たねのぶ', userLogin: 'tanenobu', durationSeconds: 180, automatic: true } as const

    expect(fillMessage('広告が{duration}秒入ります。終わるまでお待ちください', adStarted, null)).toBe('広告が180秒入ります。終わるまでお待ちください')
  })

  it('広告の終了でも {duration} が使える', () => {
    const adEnded = { event: AD_BREAK_END, userName: 'たねのぶ', userLogin: 'tanenobu', durationSeconds: 90, automatic: false } as const

    expect(fillMessage('{duration}秒の広告が終わりました。おかえりなさい', adEnded, null)).toBe('90秒の広告が終わりました。おかえりなさい')
  })

  it('報酬名に $& のような置換の特殊な指定が含まれていても、そのまま差し込む', () => {
    const redeemed = { event: REDEMPTION, userName: '田中太郎', userLogin: 'tanaka_taro', rewardId: '報酬ID', rewardTitle: '$& と $1 の報酬' } as const

    expect(fillMessage('{reward} を交換しました', redeemed, null)).toBe('$& と $1 の報酬 を交換しました')
  })

  it('配信のあらすじを {summary} に差し込む（イベント種別によらず使える）', () => {
    const followed = { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' } as const

    expect(fillMessage('{user} さん、いらっしゃい。{summary}', followed, '配信者は新しいゲームを遊んでいます')).toBe(
      '田中太郎 さん、いらっしゃい。配信者は新しいゲームを遊んでいます',
    )
  })

  it('あらすじが無ければ、{summary} を残さずその旨を差し込む（文言が欠けたように見せない）', () => {
    const followed = { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' } as const

    expect(fillMessage('これまでのあらすじ: {summary}', followed, null)).toBe('これまでのあらすじ: まだあらすじがありません')
  })

  it('あらすじに $& のような置換の特殊な指定が含まれていても、そのまま差し込む', () => {
    const followed = { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' } as const

    expect(fillMessage('{summary}', followed, '$& と $1 の話をしていました')).toBe('$& と $1 の話をしていました')
  })

  it('視聴者の発言に書かれた {summary} は、あらすじに置き換えずそのまま残す（差し込んだ値を差し込み語として読まない）', () => {
    const chatted = { event: CHAT_MESSAGE, userName: '田中太郎', userLogin: 'tanaka_taro', text: '{summary}{summary}' } as const

    expect(fillMessage('{user}「{message}」 いまの話: {summary}', chatted, '新しいゲームを遊んでいます')).toBe(
      '田中太郎「{summary}{summary}」 いまの話: 新しいゲームを遊んでいます',
    )
  })
})

describe('aiChatsFor', () => {
  const alertConfig = (triggers: StoredTrigger[]): AlertConfig => ({ triggers })
  const followNotification = { user_name: '田中太郎', user_login: 'tanaka_taro' }

  it('当てはまるトリガーの指示と、読み取ったイベントの中身を返す（文面づくりの材料になる）', () => {
    const config = alertConfig([{ kind: 'follow', actions: [{ type: 'aiChat', instruction: 'お礼を言ってください' }] }])

    expect(aiChatsFor(config, 'channel.follow', followNotification, notFirstTime)).toEqual([{
      instruction: 'お礼を言ってください',
      extracted: { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' },
    }])
  })

  it('当てはまるトリガーがなければ null を返す', () => {
    const config = alertConfig([{ kind: 'raid', actions: [{ type: 'aiChat', instruction: 'お礼を言ってください' }] }])

    expect(aiChatsFor(config, 'channel.follow', followNotification, notFirstTime)).toEqual([])
  })

  it('LLMに作らせる動作を持たないトリガー（固定文言のチャットだけ）には反応しない', () => {
    const fixedTextOnly: StoredTrigger = { kind: 'follow', actions: [{ type: 'chat', message: 'ありがとう' }] }

    expect(aiChatsFor(alertConfig([fixedTextOnly]), 'channel.follow', followNotification, notFirstTime)).toEqual([])
  })

  it('条件を満たさないトリガーには反応しない', () => {
    const firstTimeOnly: StoredTrigger = {
      kind: 'newViewer',
      actions: [{ type: 'aiChat', instruction: '初めての人を歓迎してください' }],
    }
    const chatNotification = {
      message_id: 'chat-1',
      broadcaster_user_id: '1',
      chatter_user_id: '2',
      chatter_user_login: 'hanako',
      chatter_user_name: '花子',
      message: { text: 'こんばんは' },
    }

    expect(aiChatsFor(alertConfig([firstTimeOnly]), CHAT_MESSAGE, chatNotification, notFirstTime)).toEqual([])
  })
})

describe('chatMessagesFor', () => {
  const alertConfig = (triggers: StoredTrigger[]): AlertConfig => ({ triggers })
  const followNotification = { user_name: '田中太郎', user_login: 'tanaka_taro' }

  it('当てはまるトリガーのチャットの文言を、差し込み語を置き換えて返す', () => {
    const config = alertConfig([{ kind: 'follow', actions: [{ type: 'chat', message: '{user} さん、フォローありがとうございます！' }] }])

    expect(chatMessagesFor(config, 'channel.follow', followNotification, notFirstTime, null)).toEqual(['田中太郎 さん、フォローありがとうございます！'])
  })

  it('文言の {summary} に、渡された配信のあらすじを差し込む', () => {
    const config = alertConfig([{ kind: 'follow', actions: [{ type: 'chat', message: '{user} さん、いま「{summary}」って話をしてます' }] }])

    expect(chatMessagesFor(config, 'channel.follow', followNotification, notFirstTime, '新しいゲームを遊んでいます')).toEqual([
      '田中太郎 さん、いま「新しいゲームを遊んでいます」って話をしてます',
    ])
  })

  it('視聴者の発言に書かれた {summary} は、あらすじに置き換えずそのまま送る', () => {
    const config = alertConfig([{ kind: 'everyMessage', actions: [{ type: 'chat', message: '{user}「{message}」' }] }])
    const chatMessage = {
      broadcaster_user_id: '配信者ID',
      chatter_user_id: '発言者ID',
      chatter_user_login: 'tanaka_taro',
      chatter_user_name: '田中太郎',
      message_id: '発言ID-1',
      message: { text: 'あらすじは {summary} です' },
    }

    expect(chatMessagesFor(config, CHAT_MESSAGE, chatMessage, notFirstTime, '新しいゲームを遊んでいます')).toEqual(['田中太郎「あらすじは {summary} です」'])
  })

  it('当てはまるトリガーがなければ null を返す', () => {
    const config = alertConfig([{ kind: 'raid', actions: [{ type: 'chat', message: 'レイドありがとう' }] }])

    expect(chatMessagesFor(config, 'channel.follow', followNotification, notFirstTime, null)).toEqual([])
  })

  it('チャットに送る動作を持たないトリガー（アラートを出すだけ）には反応しない', () => {
    const alertOnly: StoredTrigger = {
      kind: 'follow',
      actions: [{ type: 'alert', mediaId: '素材ID-拍手の音', mediaKind: 'audio', durationSeconds: 5, volume: 0.5, message: '' }],
    }

    expect(chatMessagesFor(alertConfig([alertOnly]), 'channel.follow', followNotification, notFirstTime, null)).toEqual([])
  })

  it('当てはまるトリガーが複数あれば、並びの順にすべて返す（どれかが黙って落とされない）', () => {
    const config = alertConfig([
      { kind: 'follow', actions: [{ type: 'chat', message: '1つ目の文言' }] },
      { kind: 'follow', actions: [{ type: 'chat', message: '2つ目の文言' }] },
    ])

    expect(chatMessagesFor(config, 'channel.follow', followNotification, notFirstTime, null)).toEqual(['1つ目の文言', '2つ目の文言'])
  })

  it('挨拶と「すべての発言」が並んでいれば、どちらも返す（読み上げや効果音は挨拶と同時に鳴ってほしい）', () => {
    const config = alertConfig([
      { kind: 'newViewer', actions: [{ type: 'chat', message: 'はじめまして！' }] },
      { kind: 'everyMessage', actions: [{ type: 'chat', message: 'どうも' }] },
    ])
    const firstSightChat = { ...notFirstTime, firstChatEver: true }
    const chatMessage = {
      broadcaster_user_id: '配信者ID',
      chatter_user_id: '発言者ID',
      chatter_user_login: 'tanaka_taro',
      chatter_user_name: '田中太郎',
      message_id: '発言ID-1',
      message: { text: 'こんにちは' },
    }

    expect(chatMessagesFor(config, CHAT_MESSAGE, chatMessage, firstSightChat, null)).toEqual(['はじめまして！', 'どうも'])
  })

  it('チャットに送るトリガーがないイベントなら、通知の中身が想定と違ってもエラーにしない（設定していないイベントで止めない）', () => {
    const config = alertConfig([{ kind: 'raid', actions: [{ type: 'chat', message: 'レイドありがとう' }] }])

    expect(chatMessagesFor(config, 'channel.follow', { user_login: 'tanaka' }, notFirstTime, null)).toEqual([])
  })

  it('対応していないイベントの種類なら null を返す', () => {
    const config = alertConfig([{ kind: 'follow', actions: [{ type: 'chat', message: 'ありがとう' }] }])

    expect(chatMessagesFor(config, 'stream.online', { id: '配信ID' }, notFirstTime, null)).toEqual([])
  })
})

describe('チャットの発言のトリガー', () => {
  const chatNotification = {
    broadcaster_user_id: '配信者ID',
    chatter_user_id: '発言者ID',
    chatter_user_login: 'tanaka_taro',
    chatter_user_name: '田中太郎',
    message_id: '発言ID-1',
    message: { text: 'みなさんおはようございます' },
  }

  it('文面の条件に当てはまる発言で、チャットの文言を返す', () => {
    const alertConfig: AlertConfig = {
      triggers: [{ kind: 'keyword', contains: 'おはよう', actions: [{ type: 'chat', message: '{user} さん、おはよう！' }] }],
    }

    expect(chatMessagesFor(alertConfig, CHAT_MESSAGE, chatNotification, notFirstTime, null)).toEqual(['田中太郎 さん、おはよう！'])
  })

  it('発言者の条件に当てはまらない発言では null を返す', () => {
    const alertConfig: AlertConfig = {
      triggers: [{ kind: 'fromUser', login: 'yamada_hanako', actions: [{ type: 'chat', message: 'やあ' }] }],
    }

    expect(chatMessagesFor(alertConfig, CHAT_MESSAGE, chatNotification, notFirstTime, null)).toEqual([])
  })

  it('本文を差し込んでTwitchの上限（500文字）を超えたら、末尾を … にして収める', () => {
    const longChatMessage = {
      ...chatNotification,
      message: { text: 'あ'.repeat(500) },
    }
    const alertConfig: AlertConfig = {
      triggers: [{ kind: 'everyMessage', actions: [{ type: 'chat', message: '{user} さんの発言: {message}' }] }],
    }

    const [textToSend] = chatMessagesFor(alertConfig, CHAT_MESSAGE, longChatMessage, notFirstTime, null)

    expect(textToSend).toHaveLength(500)
    expect(textToSend?.endsWith('…')).toBe(true)
    expect(textToSend?.startsWith('田中太郎 さんの発言: ')).toBe(true)
  })

  it('アナウンスの文言も、Twitchの上限（500文字）に収める', () => {
    const longChatMessage = { ...chatNotification, message: { text: 'あ'.repeat(500) } }
    const alertConfig: AlertConfig = {
      triggers: [{ kind: 'everyMessage', actions: [{ type: 'announce', message: '{message}', color: 'blue' }] }],
    }

    expect(announcementsFor(alertConfig, CHAT_MESSAGE, longChatMessage, notFirstTime, null)[0]?.message).toHaveLength(500)
  })

  it('発言の本文をアナウンスの文言に差し込める', () => {
    const alertConfig: AlertConfig = {
      triggers: [
        {
          kind: 'keyword', contains: 'おはよう',
          actions: [{ type: 'announce', message: '{user}: {message}', color: 'blue' }],
        },
      ],
    }

    expect(announcementsFor(alertConfig, CHAT_MESSAGE, chatNotification, notFirstTime, null)).toEqual([{ type: 'announce', message: '田中太郎: みなさんおはようございます', color: 'blue' }])
  })

  it('アナウンスの文言の {summary} に、渡された配信のあらすじを差し込む', () => {
    const emitSummary: StoredTrigger = {
      kind: 'everyMessage',
      actions: [{ type: 'announce', message: 'これまでのあらすじ: {summary}', color: 'blue' }],
    }

    expect(announcementsFor({ triggers: [emitSummary] }, CHAT_MESSAGE, chatNotification, notFirstTime, '新しいゲームを遊んでいます')[0]?.message).toBe(
      'これまでのあらすじ: 新しいゲームを遊んでいます',
    )
  })
})

describe('挨拶の段（当てはまったうち最も細かい1つだけが発動する）', () => {
  const chatNotification = {
    broadcaster_user_id: '配信者ID',
    chatter_user_id: '発言者ID',
    chatter_user_login: 'tanaka_taro',
    chatter_user_name: '田中太郎',
    message_id: '発言ID-1',
    message: { text: 'こんにちは' },
  }
  /** 挨拶の3項目すべてにチャットの効果を付けた設定（配信者が一覧のすべてを埋めた状態） */
  const allGreetingsFilled: AlertConfig = {
    triggers: [
      { kind: 'newViewer', actions: [{ type: 'chat', message: 'はじめまして！' }] },
      { kind: 'comeback', days: 30, actions: [{ type: 'chat', message: 'お久しぶりです！' }] },
      { kind: 'welcome', actions: [{ type: 'chat', message: 'おかえりなさい！' }] },
    ],
  }

  it('初めて来た人の発言では、初めて来た人の挨拶だけを送る（その配信で最初の発言でもあるが二重にしない）', () => {
    const firstSight = { firstChatOfStream: true, firstChatEver: true, daysSinceLastChat: null }

    expect(chatMessagesFor(allGreetingsFilled, CHAT_MESSAGE, chatNotification, firstSight, null)).toEqual(['はじめまして！'])
  })

  it('久しぶりの人の発言では、久しぶりの挨拶だけを送る', () => {
    const longAbsence = { firstChatOfStream: true, firstChatEver: false, daysSinceLastChat: 40 }

    expect(chatMessagesFor(allGreetingsFilled, CHAT_MESSAGE, chatNotification, longAbsence, null)).toEqual(['お久しぶりです！'])
  })

  it('常連のその配信で最初の発言では、おかえりの挨拶を送る', () => {
    const regularFirstTime = { firstChatOfStream: true, firstChatEver: false, daysSinceLastChat: 1 }

    expect(chatMessagesFor(allGreetingsFilled, CHAT_MESSAGE, chatNotification, regularFirstTime, null)).toEqual(['おかえりなさい！'])
  })

  it('その配信で2通目以降の発言では、挨拶を送らない', () => {
    const secondMessage = { firstChatOfStream: false, firstChatEver: false, daysSinceLastChat: 1 }

    expect(chatMessagesFor(allGreetingsFilled, CHAT_MESSAGE, chatNotification, secondMessage, null)).toEqual([])
  })

  it('挨拶の絞り込みは動作の種類をまたいで効く（初めて来た人にAIチャットを、その配信で最初の人にチャットを付けても二重にならない）', () => {
    const config: AlertConfig = {
      triggers: [
        { kind: 'newViewer', actions: [{ type: 'aiChat', instruction: '歓迎してください' }] },
        { kind: 'welcome', actions: [{ type: 'chat', message: 'おかえりなさい！' }] },
      ],
    }
    const firstSight = { firstChatOfStream: true, firstChatEver: true, daysSinceLastChat: null }

    expect(aiChatsFor(config, CHAT_MESSAGE, chatNotification, firstSight)).toHaveLength(1)
    expect(chatMessagesFor(config, CHAT_MESSAGE, chatNotification, firstSight, null)).toEqual([])
  })

  it('保存されている並びが細かい順でなくても、挨拶の優先順位は変わらない（KVを手で直しても入れ替わらない）', () => {
    const reversedOrder: AlertConfig = {
      triggers: [
        { kind: 'welcome', actions: [{ type: 'chat', message: 'おかえりなさい！' }] },
        { kind: 'newViewer', actions: [{ type: 'chat', message: 'はじめまして！' }] },
      ],
    }
    const firstSight = { firstChatOfStream: true, firstChatEver: true, daysSinceLastChat: null }

    expect(chatMessagesFor(reversedOrder, CHAT_MESSAGE, chatNotification, firstSight, null)).toEqual(['はじめまして！'])
  })

  it('挨拶と合言葉は同時に発動する（絞り込みの向きが違うので打ち消さない）', () => {
    const config: AlertConfig = {
      triggers: [
        { kind: 'newViewer', actions: [{ type: 'chat', message: 'はじめまして！' }] },
        { kind: 'keyword', contains: 'こんにちは', actions: [{ type: 'chat', message: 'こんにちは！' }] },
      ],
    }
    const firstSight = { firstChatOfStream: true, firstChatEver: true, daysSinceLastChat: null }

    expect(chatMessagesFor(config, CHAT_MESSAGE, chatNotification, firstSight, null)).toEqual(['はじめまして！', 'こんにちは！'])
  })
})

describe('announcementsFor', () => {
  const alertConfig = (triggers: StoredTrigger[]): AlertConfig => ({ triggers })
  const raidNotification = {
    from_broadcaster_user_id: 'レイド元のユーザーID',
    from_broadcaster_user_name: '山田花子',
    from_broadcaster_user_login: 'yamada_hanako',
    viewers: 25,
  }

  it('当てはまるトリガーのアナウンスを、差し込み語を置き換えて色ごと返す', () => {
    const config = alertConfig([
      { kind: 'raid', actions: [{ type: 'announce', message: '{user} さんが {viewers} 人で来てくれました', color: 'purple' }] },
    ])

    expect(announcementsFor(config, 'channel.raid', raidNotification, notFirstTime, null)).toEqual([{
      type: 'announce',
      message: '山田花子 さんが 25 人で来てくれました',
      color: 'purple',
    }])
  })

  it('アナウンスを送る動作を持たないトリガー（チャットに送るだけ）には反応しない', () => {
    const chatOnly: StoredTrigger = { kind: 'raid', actions: [{ type: 'chat', message: 'レイドありがとう' }] }

    expect(announcementsFor(alertConfig([chatOnly]), 'channel.raid', raidNotification, notFirstTime, null)).toEqual([])
  })

  it('当てはまるトリガーがなければ null を返す', () => {
    const config = alertConfig([{ kind: 'follow', actions: [{ type: 'announce', message: 'ありがとう', color: 'primary' }] }])

    expect(announcementsFor(config, 'channel.raid', raidNotification, notFirstTime, null)).toEqual([])
  })
})

describe('shoutoutsFor', () => {
  const alertConfig = (triggers: StoredTrigger[]): AlertConfig => ({ triggers })
  const raidNotification = {
    from_broadcaster_user_id: 'レイド元のユーザーID',
    from_broadcaster_user_name: '山田花子',
    from_broadcaster_user_login: 'yamada_hanako',
    viewers: 25,
  }

  it('当てはまるトリガーのシャウトアウトを、紹介する相手ごと返す', () => {
    const config = alertConfig([{ kind: 'raid', actions: [{ type: 'shoutout' }] }])

    expect(shoutoutsFor(config, 'channel.raid', raidNotification, notFirstTime)).toEqual([
      { userId: 'レイド元のユーザーID', userLogin: 'yamada_hanako' },
    ])
  })

  it('シャウトアウトを送る動作を持たないトリガー（チャットに送るだけ）には反応しない', () => {
    const chatOnly: StoredTrigger = { kind: 'raid', actions: [{ type: 'chat', message: 'レイドありがとう' }] }

    expect(shoutoutsFor(alertConfig([chatOnly]), 'channel.raid', raidNotification, notFirstTime)).toEqual([])
  })

  it('レイド以外のイベントのトリガーには反応しない', () => {
    const config = alertConfig([{ kind: 'raid', actions: [{ type: 'shoutout' }] }])

    expect(shoutoutsFor(config, 'channel.follow', { user_name: '田中太郎', user_login: 'tanaka_taro' }, notFirstTime)).toEqual([])
  })
})

describe('townToursFor', () => {
  const alertConfig = (triggers: StoredTrigger[]): AlertConfig => ({ triggers })
  const raidNotification = {
    from_broadcaster_user_id: 'レイド元のユーザーID',
    from_broadcaster_user_name: '山田花子',
    from_broadcaster_user_login: 'yamada_hanako',
    viewers: 25,
  }
  const dartsMessage = {
    broadcaster_user_id: '配信者ID',
    chatter_user_id: '発言者ID',
    chatter_user_login: 'tanaka_taro',
    chatter_user_name: '田中太郎',
    message_id: '発言ID-1',
    message: { text: '!darts' },
  }

  it('レイドのトリガーの市町村紹介を、レイド元の表示名と一緒に返す', () => {
    const config = alertConfig([{ kind: 'raid', actions: [{ type: 'townTour' }] }])

    expect(townToursFor(config, 'channel.raid', raidNotification, notFirstTime)).toEqual([{ occasion: 'raid', userName: '山田花子' }])
  })

  it('キーワードのトリガーの市町村紹介を、発言した人の表示名と一緒に返す', () => {
    const config = alertConfig([{ kind: 'keyword', contains: '!darts', actions: [{ type: 'townTour' }] }])

    expect(townToursFor(config, CHAT_MESSAGE, dartsMessage, notFirstTime)).toEqual([{ occasion: 'keyword', userName: '田中太郎' }])
  })

  it('市町村紹介を流す動作を持たないトリガーには反応しない', () => {
    const chatOnly: StoredTrigger = { kind: 'raid', actions: [{ type: 'chat', message: 'レイドありがとう' }] }

    expect(townToursFor(alertConfig([chatOnly]), 'channel.raid', raidNotification, notFirstTime)).toEqual([])
  })

  it('レイドとキーワード以外のトリガーに置かれていたら、黙って流さずに投げる', () => {
    const config = alertConfig([{ kind: 'follow', actions: [{ type: 'townTour' }] }])

    expect(() => townToursFor(config, 'channel.follow', { user_name: '田中太郎', user_login: 'tanaka_taro' }, notFirstTime)).toThrow(
      '市町村紹介はレイドとキーワードのトリガーにだけ置けます',
    )
  })
})

describe('firstChatOfStream の条件', () => {
  const chatted = { event: CHAT_MESSAGE, userName: '田中太郎', userLogin: 'tanaka_taro', text: 'おはようございます' } as const
  const firstTimeTrigger = resolveTrigger({ kind: 'welcome', actions: [{ type: 'chat', message: '{user} さん、おかえりなさい！' }] })

  it('その配信で初めての発言なら当てはまる', () => {
    expect(matches(firstTimeTrigger, chatted, isFirstTime)).toBe(true)
  })

  it('その配信で2回目以降の発言なら当てはまらない', () => {
    expect(matches(firstTimeTrigger, chatted, notFirstTime)).toBe(false)
  })

  it('チャットの発言以外には当てはまらない（既定メニューからは作れない組み合わせだが、照合でも通さない）', () => {
    const followWithFirstTime: ResolvedTrigger = {
      kind: 'follow',
      event: 'channel.follow',
      conditions: [{ kind: 'firstChatOfStream' }],
      actions: [{ type: 'chat', message: 'ありがとう' }],
    }
    const followed = { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' } as const

    expect(matches(followWithFirstTime, followed, isFirstTime)).toBe(false)
  })
})

describe('firstChatEver の条件', () => {
  const chatted = { event: CHAT_MESSAGE, userName: '田中太郎', userLogin: 'tanaka_taro', text: 'はじめまして' } as const
  const firstSightTrigger = resolveTrigger({ kind: 'newViewer', actions: [{ type: 'chat', message: '{user} さん、はじめまして！' }] })

  it('このチャンネルで初めての発言なら当てはまる', () => {
    expect(matches(firstSightTrigger, chatted, { ...notFirstTime, firstChatEver: true, daysSinceLastChat: null })).toBe(true)
  })

  it('記録のある人（2回目以降）の発言なら当てはまらない', () => {
    expect(matches(firstSightTrigger, chatted, notFirstTime)).toBe(false)
  })

  it('チャットの発言以外には当てはまらない（既定メニューからは作れない組み合わせだが、照合でも通さない）', () => {
    const followWithFirstSight: ResolvedTrigger = {
      kind: 'follow',
      event: 'channel.follow',
      conditions: [{ kind: 'firstChatEver' }],
      actions: [{ type: 'chat', message: 'ありがとう' }],
    }
    const followed = { event: 'channel.follow', userName: '田中太郎', userLogin: 'tanaka_taro' } as const

    expect(matches(followWithFirstSight, followed, { ...notFirstTime, firstChatEver: true })).toBe(false)
  })
})

describe('returningAfter の条件', () => {
  const chatted = { event: CHAT_MESSAGE, userName: '田中太郎', userLogin: 'tanaka_taro', text: 'おひさしぶりです' } as const
  const longAbsenceTrigger = resolveTrigger({ kind: 'comeback', days: 30, actions: [{ type: 'chat', message: '{user} さん、お久しぶりです！' }] })

  it('指定した日数ちょうど空いていれば当てはまる', () => {
    expect(matches(longAbsenceTrigger, chatted, { ...notFirstTime, daysSinceLastChat: 30 })).toBe(true)
  })

  it('指定した日数より長く空いていれば当てはまる', () => {
    expect(matches(longAbsenceTrigger, chatted, { ...notFirstTime, daysSinceLastChat: 45.5 })).toBe(true)
  })

  it('指定した日数に足りなければ当てはまらない', () => {
    expect(matches(longAbsenceTrigger, chatted, { ...notFirstTime, daysSinceLastChat: 29.9 })).toBe(false)
  })

  it('このチャンネルで初めての発言（空いた日数が決まらない）には当てはまらない', () => {
    expect(matches(longAbsenceTrigger, chatted, { firstChatOfStream: true, firstChatEver: true, daysSinceLastChat: null })).toBe(false)
  })

  it('チャットの発言以外には当てはまらない（既定メニューからは作れない組み合わせだが、照合でも通さない）', () => {
    const raidWithLongAbsence: ResolvedTrigger = {
      kind: 'raid',
      event: 'channel.raid',
      conditions: [{ kind: 'returningAfter', days: 30 }],
      actions: [{ type: 'chat', message: 'ありがとう' }],
    }
    const raided = { event: 'channel.raid', userId: 'レイド元のユーザーID', userName: '田中太郎', userLogin: 'tanaka_taro', viewers: 10 } as const

    expect(matches(raidWithLongAbsence, raided, { ...notFirstTime, daysSinceLastChat: 40 })).toBe(false)
  })
})

describe('requiresChatHistory', () => {
  const firstSightTrigger: StoredTrigger = { kind: 'newViewer', actions: [{ type: 'chat', message: 'はじめまして' }] }
  const longAbsenceTrigger: StoredTrigger = {
    kind: 'comeback', days: 30,
    actions: [{ type: 'chat', message: 'お久しぶりです' }],
  }
  /** 視聴者の記録を見なくても判定できる条件だけを持つトリガー */
  const noRecordTrigger: StoredTrigger = {
    kind: 'welcome',
    actions: [{ type: 'chat', message: 'おかえりなさい' }],
  }

  it('そのイベントに firstChatEver の条件を持つトリガーがあれば true', () => {
    expect(requiresChatHistory({ triggers: [noRecordTrigger, firstSightTrigger] }, CHAT_MESSAGE)).toBe(true)
  })

  it('そのイベントに returningAfter の条件を持つトリガーがあれば true', () => {
    expect(requiresChatHistory({ triggers: [longAbsenceTrigger] }, CHAT_MESSAGE)).toBe(true)
  })

  it('どちらの条件も持つトリガーが1件もなければ false（データベースを触らずに済ませるため）', () => {
    expect(requiresChatHistory({ triggers: [noRecordTrigger] }, CHAT_MESSAGE)).toBe(false)
  })

  it('別のイベントの通知では false', () => {
    expect(requiresChatHistory({ triggers: [firstSightTrigger] }, 'channel.follow')).toBe(false)
  })
})

describe('requiresFirstChatOfStream', () => {
  const firstTimeTrigger: StoredTrigger = {
    kind: 'welcome',
    actions: [{ type: 'chat', message: 'おかえりなさい！' }],
  }
  const unconditionalTrigger: StoredTrigger = { kind: 'everyMessage', actions: [{ type: 'chat', message: 'どうも' }] }

  it('そのイベントに firstChatOfStream の条件を持つトリガーがあれば true', () => {
    expect(requiresFirstChatOfStream({ triggers: [unconditionalTrigger, firstTimeTrigger] }, CHAT_MESSAGE)).toBe(true)
  })

  it('その条件を持つトリガーが1件もなければ false（データベースを触らずに済ませるため）', () => {
    expect(requiresFirstChatOfStream({ triggers: [unconditionalTrigger] }, CHAT_MESSAGE)).toBe(false)
  })

  it('別のイベントの通知では false', () => {
    expect(requiresFirstChatOfStream({ triggers: [firstTimeTrigger] }, 'channel.follow')).toBe(false)
  })
})

describe('requiresStreamSummary', () => {
  const summaryUsingTrigger: StoredTrigger = {
    kind: 'everyMessage',
    actions: [{ type: 'chat', message: 'これまでのあらすじ: {summary}' }],
  }
  const summaryNotUsingTrigger: StoredTrigger = { kind: 'everyMessage', actions: [{ type: 'chat', message: 'どうも' }] }

  it('そのイベントに {summary} を含む文言を持つトリガーがあれば true', () => {
    expect(requiresStreamSummary({ triggers: [summaryNotUsingTrigger, summaryUsingTrigger] }, CHAT_MESSAGE)).toBe(true)
  })

  it('アラートの文言（オーバーレイに出す文言）に含まれていても true', () => {
    const alertText: StoredTrigger = {
      kind: 'everyMessage',
      actions: [{ type: 'alert', mediaId: '素材ID', mediaKind: 'image', durationSeconds: 5, volume: 1, message: '{summary}' }],
    }

    expect(requiresStreamSummary({ triggers: [alertText] }, CHAT_MESSAGE)).toBe(true)
  })

  it('アナウンスの文言に含まれていても true', () => {
    const announceText: StoredTrigger = {
      kind: 'everyMessage',
      actions: [{ type: 'announce', message: '{summary}', color: 'blue' }],
    }

    expect(requiresStreamSummary({ triggers: [announceText] }, CHAT_MESSAGE)).toBe(true)
  })

  it('{summary} を使う文言が1件もなければ false（データベースを触らずに済ませるため）', () => {
    expect(requiresStreamSummary({ triggers: [summaryNotUsingTrigger] }, CHAT_MESSAGE)).toBe(false)
  })

  it('文面をLLMに作らせる動作（aiChat）があれば、文言に書かれていなくても true（あらすじも材料にするため）', () => {
    const generateWithLlm: StoredTrigger = {
      kind: 'everyMessage',
      actions: [{ type: 'aiChat', instruction: '話の流れに合わせて返してください' }],
    }

    expect(requiresStreamSummary({ triggers: [generateWithLlm] }, CHAT_MESSAGE)).toBe(true)
  })

  it('別のイベントの通知では false', () => {
    expect(requiresStreamSummary({ triggers: [summaryUsingTrigger] }, 'channel.follow')).toBe(false)
  })
})

describe('hasAlertAction', () => {
  const alertTrigger: StoredTrigger = {
    kind: 'everyMessage',
    actions: [{ type: 'alert', mediaId: '素材ID', mediaKind: 'image', durationSeconds: 5, volume: 1, message: 'ありがとう' }],
  }
  const chatOnlyTrigger: StoredTrigger = { kind: 'everyMessage', actions: [{ type: 'chat', message: 'どうも' }] }

  it('そのイベントにアラートを出す動作を持つトリガーがあれば true', () => {
    expect(hasAlertAction({ triggers: [chatOnlyTrigger, alertTrigger] }, CHAT_MESSAGE)).toBe(true)
  })

  it('アラートを出す動作が1件もなければ false（オーバーレイ用キーを読みに行かずに済ませるため）', () => {
    expect(hasAlertAction({ triggers: [chatOnlyTrigger] }, CHAT_MESSAGE)).toBe(false)
  })

  it('別のイベントの通知では false', () => {
    expect(hasAlertAction({ triggers: [alertTrigger] }, 'channel.follow')).toBe(false)
  })
})

describe('alertsFor', () => {
  it('当てはまるトリガーが複数あれば、並びの順にすべてのアラートを返す（オーバーレイが順に再生する）', () => {
    const twoItems: AlertConfig = {
      triggers: [
        { kind: 'newViewer', actions: [{ ...alertAction, message: 'はじめまして' }] },
        { kind: 'everyMessage', actions: [{ ...alertAction, message: 'どうも' }] },
      ],
    }
    const chatMessage = {
      broadcaster_user_id: '配信者ID',
      chatter_user_id: '発言者ID',
      chatter_user_login: 'tanaka_taro',
      chatter_user_name: '田中太郎',
      message_id: '発言ID-1',
      message: { text: 'こんにちは' },
    }

    expect(alertsFor(twoItems, CHAT_MESSAGE, chatMessage, overlayKey, { ...notFirstTime, firstChatEver: true }, null).map((alert) => alert.text)).toEqual([
      'はじめまして',
      'どうも',
    ])
  })

  const overlayKey = 'overlay-key_1'
  const followNotification = { user_name: '田中太郎', user_login: 'tanaka_taro' }

  it('視聴者の発言に書かれた {summary} は、あらすじに置き換えずアラート文にそのまま出す（文が際限なく長くならない）', () => {
    const config: AlertConfig = { triggers: [{ kind: 'everyMessage', actions: [{ ...alertAction, message: '{message}' }] }] }
    const chatMessage = {
      broadcaster_user_id: '配信者ID',
      chatter_user_id: '発言者ID',
      chatter_user_login: 'tanaka_taro',
      chatter_user_name: '田中太郎',
      message_id: '発言ID-1',
      message: { text: '{summary}{summary}{summary}' },
    }

    expect(alertsFor(config, CHAT_MESSAGE, chatMessage, overlayKey, notFirstTime, '新しいゲームを遊んでいます').map((alert) => alert.text)).toEqual([
      '{summary}{summary}{summary}',
    ])
  })
  const alertAction = {
    type: 'alert',
    mediaId: '素材ID-乾杯の動画',
    mediaKind: 'video',
    durationSeconds: 8,
    volume: 0.5,
    message: '{user} さん、ありがとう！',
  } as const

  it('当てはまるトリガーのアラートを、素材のURLと差し込み後の文言で返す', () => {
    const config: AlertConfig = { triggers: [{ kind: 'follow', actions: [alertAction] }] }

    expect(alertsFor(config, 'channel.follow', followNotification, overlayKey, notFirstTime, null)).toEqual([{
      media: { kind: 'video', url: '/api/media/%E7%B4%A0%E6%9D%90ID-%E4%B9%BE%E6%9D%AF%E3%81%AE%E5%8B%95%E7%94%BB?key=overlay-key_1' },
      durationSeconds: 8,
      volume: 0.5,
      text: '田中太郎 さん、ありがとう！',
    }])
  })

  it('画面に出す文言の {summary} に、渡された配信のあらすじを差し込む', () => {
    const showSummary = { ...alertAction, message: 'これまでのあらすじ: {summary}' }
    const config: AlertConfig = { triggers: [{ kind: 'follow', actions: [showSummary] }] }

    expect(alertsFor(config, 'channel.follow', followNotification, overlayKey, notFirstTime, '新しいゲームを遊んでいます')[0]?.text).toBe(
      'これまでのあらすじ: 新しいゲームを遊んでいます',
    )
  })

  it('アラートを出す動作を持たないトリガー（チャットに送るだけ）には反応しない', () => {
    const config: AlertConfig = { triggers: [{ kind: 'follow', actions: [{ type: 'chat', message: 'ありがとう' }] }] }

    expect(alertsFor(config, 'channel.follow', followNotification, overlayKey, notFirstTime, null)).toEqual([])
  })

  it('当てはまるトリガーがなければ null を返す', () => {
    const config: AlertConfig = { triggers: [{ kind: 'raid', actions: [alertAction] }] }

    expect(alertsFor(config, 'channel.follow', followNotification, overlayKey, notFirstTime, null)).toEqual([])
  })

  it('firstChatOfStream の条件を持つトリガーは、その配信で初めての発言のときだけ再生する', () => {
    const chatNotification = {
      broadcaster_user_id: '配信者ID',
      chatter_user_id: '発言者ID',
      chatter_user_login: 'tanaka_taro',
      chatter_user_name: '田中太郎',
      message_id: '発言ID-1',
      message: { text: 'おはようございます' },
    }
    const config: AlertConfig = { triggers: [{ kind: 'welcome', actions: [alertAction] }] }

    expect(alertsFor(config, CHAT_MESSAGE, chatNotification, overlayKey, isFirstTime, null)[0]?.text).toBe('田中太郎 さん、ありがとう！')
    expect(alertsFor(config, CHAT_MESSAGE, chatNotification, overlayKey, notFirstTime, null)).toEqual([])
  })
})
