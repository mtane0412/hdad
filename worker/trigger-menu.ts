/**
 * トリガーの既定メニュー
 *
 * 配信で実際に起きる出来事に名前を付けた「メニュー項目」を持ち、それを照合で使う形（イベント種別と条件のリスト）へ展開する。
 * 配信者が決めるのは「メニューのどれか」と「そのメニューが要求するパラメータ（あれば1つ）」だけで、
 * イベント種別と条件の組み合わせはこのファイルが決める。
 *
 * このツールは汎用のノーコード自動化を目指していないため、イベント種別と条件を自由に組み合わせる方式は採らない。
 * 自由に組めると、配信者は「初見さんに反応したい」と思っても「チャットの発言を選ぶ → firstChatEver の条件を足す」という
 * 2段の手順を踏むことになり、意味を持たない組み合わせ（フォロー かつ 特定のユーザー）も作れてしまう。
 *
 * 展開の結果は worker/alert-event.ts の matches がそのまま受け取る。照合そのもの（条件を満たすかの判定）は
 * このファイルには無く、alert-event.ts だけが持つ（判定を2か所に持たないため）。
 *
 * 注意: 「すべての報酬」「自動・手動どちらの広告でも」は、メニュー項目を増やさずパラメータの null で表す。
 *   展開した結果は条件を1件も持たない形になり、そのイベントが起きればいつでも当てはまる。
 */

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
const FOLLOW = 'channel.follow'
const SUBSCRIBE = 'channel.subscribe'
const SUBSCRIPTION_MESSAGE = 'channel.subscription.message'
const RAID = 'channel.raid'
const CHAT_MESSAGE = 'channel.chat.message'
/** 広告の開始。Twitchから届く通知（channel.ad_break.begin）に対応する */
export const AD_BREAK_BEGIN = 'channel.ad_break.begin'
/**
 * 広告の終了。Twitchにこの種類の通知はなく、Workerが自前で作る擬似イベントである。
 *
 * 開始の通知に入っている duration_seconds から終わる時刻を出し、そのときに同じ照合へ回す
 * （worker/ad-break-timer.ts）。購読の一覧（worker/eventsub.ts の EVENT_TYPES）には入らない。
 */
export const AD_BREAK_END = 'channel.ad_break.end'

/**
 * トリガーが対象にできるイベントの種類。
 *
 * 配信者はこれを直接選ばない（メニュー項目から決まる）。照合と、文言の差し込み語の種類を決めるために使う。
 */
export const ALERT_EVENTS = [REDEMPTION, FOLLOW, SUBSCRIBE, SUBSCRIPTION_MESSAGE, RAID, CHAT_MESSAGE, AD_BREAK_BEGIN, AD_BREAK_END] as const

export type AlertEvent = (typeof ALERT_EVENTS)[number]

/**
 * 照合に使う条件1件。
 *
 * メニュー項目から展開して作るもので、配信者が直接組み立てることはない。
 * 1つのメニュー項目が持つ条件は0件か1件で、複数の条件を and でつなぐ形はこのツールでは作れない。
 *
 * - reward: 対象の報酬ID。チャンネルポイントの交換にしか意味を持たない
 * - user: そのイベントの相手のTwitchのユーザー名（login）
 * - text: 発言の本文に含まれる文字（部分一致）
 * - firstChatOfStream: その配信で初めての発言であること。通知の中身では決まらず、
 *   データベースの記録から決まる（判定は worker/chat-store.ts の claimFirstChatOfStream）
 * - firstChatEver: このチャンネルで初めての発言であること（判定は worker/viewer-store.ts の readChatHistory）
 * - returningAfter: 最後の発言から days 日以上空いていること。初めての発言では当てはまらない
 * - automatic: 自動で入った広告か（true）、配信者が手動で打った広告か（false）
 */
export type StoredCondition =
  | { kind: 'reward'; rewardId: string }
  | { kind: 'user'; login: string }
  | { kind: 'text'; contains: string }
  | { kind: 'firstChatOfStream' }
  | { kind: 'firstChatEver' }
  | { kind: 'returningAfter'; days: number }
  | { kind: 'automatic'; automatic: boolean }

/**
 * メニュー項目の識別子。
 *
 * 画面ではこれを区分（視聴者・応援・配信）に分けて並べる。区分と日本語の名前は管理画面（src/admin/）が持つ
 * （Workerはブラウザ向けの表示を持たない）。
 */
export const TRIGGER_KINDS = [
  'chat',
  'firstChatEver',
  'firstChatOfStream',
  'returningAfter',
  'chatFromUser',
  'chatContains',
  'reward',
  'follow',
  'subscribe',
  'resubscribe',
  'raid',
  'adBreakBegin',
  'adBreakEnd',
] as const

export type TriggerKind = (typeof TRIGGER_KINDS)[number]

/**
 * トリガーのきっかけ（メニュー項目と、そのパラメータ）。
 *
 * パラメータは入れ子にせず、kind と同じ階層に平たく持つ（StoredCondition・StoredAction と同じ持ち方）。
 * null を取るパラメータは「絞り込まない」を表す（rewardId ならすべての報酬、automatic なら自動・手動のどちらでも）。
 */
export type TriggerSource =
  | { kind: 'chat' | 'firstChatEver' | 'firstChatOfStream' }
  | { kind: 'returningAfter'; days: number }
  | { kind: 'chatFromUser'; login: string }
  | { kind: 'chatContains'; contains: string }
  | { kind: 'reward'; rewardId: string | null }
  | { kind: 'follow' | 'subscribe' | 'resubscribe' | 'raid' }
  | { kind: 'adBreakBegin' | 'adBreakEnd'; automatic: boolean | null }

/** メニュー項目が対象にするイベント種別 */
const EVENT_OF_KIND: Readonly<Record<TriggerKind, AlertEvent>> = {
  chat: CHAT_MESSAGE,
  firstChatEver: CHAT_MESSAGE,
  firstChatOfStream: CHAT_MESSAGE,
  returningAfter: CHAT_MESSAGE,
  chatFromUser: CHAT_MESSAGE,
  chatContains: CHAT_MESSAGE,
  reward: REDEMPTION,
  follow: FOLLOW,
  subscribe: SUBSCRIBE,
  resubscribe: SUBSCRIPTION_MESSAGE,
  raid: RAID,
  adBreakBegin: AD_BREAK_BEGIN,
  adBreakEnd: AD_BREAK_END,
}

/**
 * メニュー項目が対象にするイベント種別を引く。
 *
 * 文言で使える差し込み語はイベント種別ごとに決まるため、画面でも同じ対応が要る（src/admin/form.ts が同じ表を持つ）。
 */
export const eventOf = (kind: TriggerKind): AlertEvent => EVENT_OF_KIND[kind]

/**
 * メニュー項目を、照合で使う形（イベント種別と条件のリスト）へ展開する。
 *
 * 通信も時刻も持たない純粋な関数なので、呼び出す側は結果を持ち回らずその場で展開してよい。
 */
export const expandSource = (source: TriggerSource): { event: AlertEvent; conditions: StoredCondition[] } => {
  const event = eventOf(source.kind)
  switch (source.kind) {
    // 絞り込みを持たないメニュー項目。そのイベントが起きればいつでも当てはまる
    case 'chat':
    case 'follow':
    case 'subscribe':
    case 'resubscribe':
    case 'raid':
      return { event, conditions: [] }
    case 'firstChatEver':
    case 'firstChatOfStream':
      return { event, conditions: [{ kind: source.kind }] }
    case 'returningAfter':
      return { event, conditions: [{ kind: 'returningAfter', days: source.days }] }
    case 'chatFromUser':
      return { event, conditions: [{ kind: 'user', login: source.login }] }
    case 'chatContains':
      return { event, conditions: [{ kind: 'text', contains: source.contains }] }
    // 報酬を選んでいなければ（null）すべての報酬が対象なので、絞り込みを付けない
    case 'reward':
      return { event, conditions: source.rewardId === null ? [] : [{ kind: 'reward', rewardId: source.rewardId }] }
    // 自動・手動を問わなければ（null）どちらの広告でも対象なので、絞り込みを付けない
    case 'adBreakBegin':
    case 'adBreakEnd':
      return { event, conditions: source.automatic === null ? [] : [{ kind: 'automatic', automatic: source.automatic }] }
  }
}
