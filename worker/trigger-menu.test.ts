/**
 * トリガーの既定メニュー（trigger-menu.ts）のテスト
 *
 * メニュー項目（kind とそのパラメータ）が、照合で使う形（イベント種別と条件のリスト）へ正しく展開されることを確認する。
 * 展開の結果は worker/alert-event.ts の matches がそのまま受け取るので、ここが狂うとアラートが鳴らない・鳴りすぎる。
 * パラメータに「すべての報酬」「自動・手動どちらの広告でも」を表す null を渡したときに、条件が1件も付かないことも確認する。
 */
import { describe, expect, it } from 'vitest'
import { GREETING_KINDS, TRIGGER_KINDS, expandSource, eventOf, isGreeting, type TriggerSource } from './trigger-menu'

const CHAT_MESSAGE = 'channel.chat.message'
const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'

describe('GREETING_KINDS', () => {
  it('挨拶の段は、細かい順に並べた3項目である（この並びが優先順位になる）', () => {
    expect(GREETING_KINDS).toEqual(['newViewer', 'comeback', 'welcome'])
  })

  it('「すべての発言」は挨拶の段に入れない（読み上げや効果音は挨拶と同時に鳴ってほしいため）', () => {
    expect(isGreeting('everyMessage')).toBe(false)
    expect(isGreeting('newViewer')).toBe(true)
  })
})

describe('expandSource', () => {
  it('条件を持たないメニュー項目は、イベント種別だけになる', () => {
    expect(expandSource({ kind: 'everyMessage' })).toEqual({ event: CHAT_MESSAGE, conditions: [] })
    expect(expandSource({ kind: 'follow' })).toEqual({ event: 'channel.follow', conditions: [] })
    expect(expandSource({ kind: 'subscribe' })).toEqual({ event: 'channel.subscribe', conditions: [] })
    expect(expandSource({ kind: 'resubscribe' })).toEqual({ event: 'channel.subscription.message', conditions: [] })
    expect(expandSource({ kind: 'raid' })).toEqual({ event: 'channel.raid', conditions: [] })
  })

  it('挨拶のメニュー項目は、チャットの発言と対応する条件になる', () => {
    expect(expandSource({ kind: 'newViewer' })).toEqual({ event: CHAT_MESSAGE, conditions: [{ kind: 'firstChatEver' }] })
    expect(expandSource({ kind: 'welcome' })).toEqual({ event: CHAT_MESSAGE, conditions: [{ kind: 'firstChatOfStream' }] })
  })

  it('久しぶりの人が発言したメニュー項目は、日数を持つ条件になる', () => {
    expect(expandSource({ kind: 'comeback', days: 30 })).toEqual({ event: CHAT_MESSAGE, conditions: [{ kind: 'returningAfter', days: 30 }] })
  })

  it('決まった人が発言したメニュー項目は、ユーザー名の条件になる', () => {
    expect(expandSource({ kind: 'fromUser', login: 'tanenobu' })).toEqual({ event: CHAT_MESSAGE, conditions: [{ kind: 'user', login: 'tanenobu' }] })
  })

  it('決まった言葉を含む発言のメニュー項目は、文面の条件になる', () => {
    expect(expandSource({ kind: 'keyword', contains: 'おはよう' })).toEqual({ event: CHAT_MESSAGE, conditions: [{ kind: 'text', contains: 'おはよう' }] })
  })

  it('報酬を選んだチャンネルポイントの交換は、報酬IDの条件になる', () => {
    expect(expandSource({ kind: 'reward', rewardId: '報酬ID-乾杯' })).toEqual({ event: REDEMPTION, conditions: [{ kind: 'reward', rewardId: '報酬ID-乾杯' }] })
  })

  it('報酬を選ばないチャンネルポイントの交換は、条件を持たない（すべての報酬が対象になる）', () => {
    expect(expandSource({ kind: 'reward', rewardId: null })).toEqual({ event: REDEMPTION, conditions: [] })
  })

  it('広告のメニュー項目は、自動か手動かを指定したときだけ条件になる', () => {
    expect(expandSource({ kind: 'adBreakBegin', automatic: true })).toEqual({
      event: 'channel.ad_break.begin',
      conditions: [{ kind: 'automatic', automatic: true }],
    })
    expect(expandSource({ kind: 'adBreakEnd', automatic: false })).toEqual({
      event: 'channel.ad_break.end',
      conditions: [{ kind: 'automatic', automatic: false }],
    })
  })

  it('自動・手動を問わない広告のメニュー項目は、条件を持たない', () => {
    expect(expandSource({ kind: 'adBreakBegin', automatic: null })).toEqual({ event: 'channel.ad_break.begin', conditions: [] })
    expect(expandSource({ kind: 'adBreakEnd', automatic: null })).toEqual({ event: 'channel.ad_break.end', conditions: [] })
  })

  /**
   * メニュー項目を足したときに、展開を書き忘れたまま保存できてしまうことを防ぐための確認である。
   * 展開を書き忘れると、そのメニューのトリガーは決して当てはまらない（配信中に気付けない）。
   */
  it('すべてのメニュー項目が、対応しているイベント種別に展開される', () => {
    const サンプル: Readonly<Record<(typeof TRIGGER_KINDS)[number], TriggerSource>> = {
      newViewer: { kind: 'newViewer' },
      comeback: { kind: 'comeback', days: 1 },
      welcome: { kind: 'welcome' },
      everyMessage: { kind: 'everyMessage' },
      keyword: { kind: 'keyword', contains: 'おはよう' },
      fromUser: { kind: 'fromUser', login: 'tanenobu' },
      reward: { kind: 'reward', rewardId: null },
      follow: { kind: 'follow' },
      subscribe: { kind: 'subscribe' },
      resubscribe: { kind: 'resubscribe' },
      raid: { kind: 'raid' },
      adBreakBegin: { kind: 'adBreakBegin', automatic: null },
      adBreakEnd: { kind: 'adBreakEnd', automatic: null },
    }
    for (const kind of TRIGGER_KINDS) {
      expect(expandSource(サンプル[kind]).event).toBe(eventOf(kind))
    }
  })
})
