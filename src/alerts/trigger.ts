/**
 * トリガーの照合
 *
 * トリガーは「どのイベントで、どの素材を、どう出すか」の設定1件。届いた通知をトリガーの一覧と照らし合わせ、
 * 画面に出すアラート（素材・表示時間・音量・文言）へ変換する。
 * 対応しているイベントは、Workerが購読している5種類（ALERT_EVENTS）。
 *
 * 出し方（AlertAppearance）はイベント種別によらず共通で、絞り込みは条件（AlertCondition）のリストで表す。
 * 条件はすべてを満たしたときだけトリガーが当てはまる（and）。条件を1件も持たないトリガーは、そのイベントが起きればいつでも当てはまる。
 *
 * 注意: Worker側（worker/alert-config.ts の StoredCondition・worker/alert-event.ts の matches）と同じ役目のコードを別に持っている。
 * worker/ と src/ は互いに読み込まない約束のため、条件の種類と判定の内容は両方で同じにする。
 */
import type { EventSubNotification } from './eventsub'

/** アラートを出せるイベントの種類。Workerの購読（worker/eventsub.ts の EVENT_TYPES）と対応する */
export const ALERT_EVENTS = [
  'channel.channel_points_custom_reward_redemption.add',
  'channel.follow',
  'channel.subscribe',
  'channel.subscription.message',
  'channel.raid',
] as const

export type AlertEvent = (typeof ALERT_EVENTS)[number]

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
const FOLLOW = 'channel.follow'
const SUBSCRIBE = 'channel.subscribe'
const SUBSCRIPTION_MESSAGE = 'channel.subscription.message'
const RAID = 'channel.raid'

/** Twitchが返すティアの値と、文言に差し込む表記の対応 */
const TIER_LABELS: Readonly<Record<string, string>> = { '1000': '1', '2000': '2', '3000': '3' }

/** 再生する素材。image は静止画・アニメーション画像、audio は音だけ */
export interface AlertMedia {
  readonly kind: 'image' | 'video' | 'audio'
  readonly url: string
}

/** 出し方（イベント種別によらず共通） */
interface AlertAppearance {
  readonly media: AlertMedia
  /** 表示する秒数 */
  readonly durationSeconds: number
  /** 音量（0〜1）。動画と音声に使う */
  readonly volume: number
  /** 表示する文言。イベント種別ごとの差し込み語が置き換わる。空文字なら文言を出さない */
  readonly message: string
}

/**
 * 条件1件。種類（kind）で判別する union（worker/alert-config.ts の StoredCondition と同じ形）。
 *
 * - reward: 対象の報酬ID。チャンネルポイントの交換にしか意味を持たない
 * - user: そのイベントの相手（交換した人・フォローした人・レイドした配信者など）のTwitchのユーザー名（login）
 */
export type AlertCondition = { readonly kind: 'reward'; readonly rewardId: string } | { readonly kind: 'user'; readonly login: string }

/** 条件（イベント種別と、すべて満たすべき条件のリスト） */
interface AlertTriggerCondition {
  readonly event: AlertEvent
  readonly conditions: readonly AlertCondition[]
}

export type AlertTrigger = AlertAppearance & AlertTriggerCondition

/** 画面に出すアラート1件 */
export interface Alert {
  readonly media: AlertMedia
  readonly durationSeconds: number
  readonly volume: number
  readonly text: string
}

/**
 * イベント種別ごとに通知から取り出した項目。文言の差し込みと条件の照合の両方に使う。
 *
 * userName は表示名（文言に差し込む）、userLogin はTwitchのユーザー名（user の条件と照らし合わせる）。
 * 表示名は本人が変えられるため、条件の照合には変わらない userLogin を使う。
 */
export type Extracted =
  | { readonly event: typeof REDEMPTION; readonly userName: string; readonly userLogin: string; readonly rewardId: string; readonly rewardTitle: string }
  | { readonly event: typeof FOLLOW; readonly userName: string; readonly userLogin: string }
  | { readonly event: typeof SUBSCRIBE; readonly userName: string; readonly userLogin: string; readonly tier: string }
  | {
      readonly event: typeof SUBSCRIPTION_MESSAGE
      readonly userName: string
      readonly userLogin: string
      readonly tier: string
      readonly cumulativeMonths: number
    }
  | { readonly event: typeof RAID; readonly userName: string; readonly userLogin: string; readonly viewers: number }

type EventBody = Readonly<Record<string, unknown>>

/** イベントの中身から文字列の項目を読む。無ければどの項目が欠けているかを示してエラーにする */
const readString = (event: EventBody, key: string): string => {
  const value = event[key]
  if (typeof value !== 'string') throw new Error(`イベントの通知に ${key} がありません`)
  return value
}

/** イベントの中身から数値の項目を読む */
const readNumber = (event: EventBody, key: string): number => {
  const value = event[key]
  if (typeof value !== 'number') throw new Error(`イベントの通知に ${key} がありません`)
  return value
}

/** チャンネルポイント交換の reward（入れ子のオブジェクト）から報酬IDと報酬名を読む */
const readReward = (event: EventBody): { rewardId: string; rewardTitle: string } => {
  const { reward } = event
  if (typeof reward !== 'object' || reward === null) throw new Error('チャンネルポイント交換の通知に reward がありません')
  const { id, title } = reward as Record<string, unknown>
  if (typeof id !== 'string' || typeof title !== 'string') throw new Error('チャンネルポイント交換の通知の reward に id または title がありません')
  return { rewardId: id, rewardTitle: title }
}

/**
 * 通知から、照合と文言に使う項目をイベント種別ごとに取り出す。
 *
 * @returns 対応していないイベント種別なら null（Twitchがイベント種別を増やしてもオーバーレイを止めないため、ここだけは例外にしない）
 * @throws 通知の中身が想定した形でない場合
 */
export const extract = (notification: EventSubNotification): Extracted | null => {
  const event = notification.event
  switch (notification.subscriptionType) {
    case REDEMPTION:
      return { event: REDEMPTION, userName: readString(event, 'user_name'), userLogin: readString(event, 'user_login'), ...readReward(event) }
    case FOLLOW:
      return { event: FOLLOW, userName: readString(event, 'user_name'), userLogin: readString(event, 'user_login') }
    case SUBSCRIBE:
      return { event: SUBSCRIBE, userName: readString(event, 'user_name'), userLogin: readString(event, 'user_login'), tier: readString(event, 'tier') }
    case SUBSCRIPTION_MESSAGE:
      return {
        event: SUBSCRIPTION_MESSAGE,
        userName: readString(event, 'user_name'),
        userLogin: readString(event, 'user_login'),
        tier: readString(event, 'tier'),
        cumulativeMonths: readNumber(event, 'cumulative_months'),
      }
    // レイドは通知を受け取る側（配信者）が to_broadcaster なので、レイドした配信者は from_broadcaster に入る
    case RAID:
      return {
        event: RAID,
        userName: readString(event, 'from_broadcaster_user_name'),
        userLogin: readString(event, 'from_broadcaster_user_login'),
        viewers: readNumber(event, 'viewers'),
      }
    default:
      return null
  }
}

/**
 * 条件1件が、取り出した項目を満たすか。
 *
 * reward の条件はチャンネルポイントの交換にしか意味を持たないため、ほかのイベントでは満たさないものとして扱う。
 * user の条件は大文字小文字を区別しない（Twitchのユーザー名は小文字だが、配信者が表示名の綴りで入れても当てられるようにする）。
 */
const satisfiesCondition = (condition: AlertCondition, extracted: Extracted): boolean => {
  switch (condition.kind) {
    case 'reward':
      return extracted.event === REDEMPTION && condition.rewardId === extracted.rewardId
    case 'user':
      return condition.login.toLowerCase() === extracted.userLogin.toLowerCase()
  }
}

/** トリガーが、取り出した項目に当てはまるか。イベント種別が同じで、条件をすべて満たすときに当てはまる（and） */
export const matches = (trigger: AlertTrigger, extracted: Extracted): boolean =>
  trigger.event === extracted.event && trigger.conditions.every((condition) => satisfiesCondition(condition, extracted))

/**
 * ティアの表記。Twitchが返す "1000" などを 1 に直す。
 *
 * 注意: 対応表にない値はそのまま出す。Twitchがティアを増やした場合に、
 * 文言だけ崩れても配信中のアラートは出し続けるため（配信者が値を見て気付ける）。
 */
const tierLabel = (tier: string): string => TIER_LABELS[tier] ?? tier

/** 文言に差し込む語と、その値の対応をイベント種別ごとに作る */
const placeholderValues = (extracted: Extracted): Record<string, string> => {
  switch (extracted.event) {
    case REDEMPTION:
      return { '{user}': extracted.userName, '{reward}': extracted.rewardTitle }
    case FOLLOW:
      return { '{user}': extracted.userName }
    case SUBSCRIBE:
      return { '{user}': extracted.userName, '{tier}': tierLabel(extracted.tier) }
    case SUBSCRIPTION_MESSAGE:
      return { '{user}': extracted.userName, '{tier}': tierLabel(extracted.tier), '{months}': String(extracted.cumulativeMonths) }
    case RAID:
      return { '{user}': extracted.userName, '{viewers}': String(extracted.viewers) }
  }
}

/**
 * 文言の差し込み語を置き換える。そのイベントに存在しない語は、配信者が入力の誤りに気付けるよう置き換えずに残す。
 *
 * 注意: 置き換える値は関数で渡す。文字列で渡すと `$&` などが置換の特殊な指定として解釈され、
 * 報酬名にそうした文字が含まれるときに意図しない文言になる。
 */
export const fillMessage = (template: string, extracted: Extracted): string =>
  Object.entries(placeholderValues(extracted)).reduce((text, [placeholder, value]) => text.replaceAll(placeholder, () => value), template)

/**
 * 通知に当てはまるトリガーを探し、アラートへ変換する。
 *
 * @param triggers トリガーの一覧。複数が当てはまる場合は先に書かれたものを使う
 * @returns 対応していないイベント種別、または当てはまるトリガーがなければ null
 * @throws 通知の中身が想定した形でない場合
 */
export const toAlert = (triggers: readonly AlertTrigger[], notification: EventSubNotification): Alert | null => {
  const extracted = extract(notification)
  if (extracted === null) return null

  const trigger = triggers.find((candidate) => matches(candidate, extracted))
  if (!trigger) return null

  return {
    media: trigger.media,
    durationSeconds: trigger.durationSeconds,
    volume: trigger.volume,
    text: fillMessage(trigger.message, extracted),
  }
}
