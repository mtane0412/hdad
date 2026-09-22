/**
 * アラートのイベントの読み取り
 *
 * Twitchから届いた通知の中身から、条件の照合と文言の差し込みに使う項目をイベント種別ごとに取り出し、
 * トリガーの一覧と照らし合わせて「チャットに送る文言」を決める（送信そのものは呼び出し側が行う）。
 *
 * 注意: オーバーレイ側の src/alerts/trigger.ts と同じ役目のコードを別に持っている。worker/ からは src/ を読み込まない約束のため。
 * 差し込み語（{user} など）とティアの表記は両方で同じにする（管理画面が案内する差し込み語が動作の種類で変わると混乱するため）。
 */
import { announceActionOf, chatActionOf, type AlertConfig, type StoredAnnounceAction, type StoredCondition, type StoredTrigger } from './alert-config'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
const FOLLOW = 'channel.follow'
const SUBSCRIBE = 'channel.subscribe'
const SUBSCRIPTION_MESSAGE = 'channel.subscription.message'
const RAID = 'channel.raid'

/** Twitchが返すティアの値と、文言に差し込む表記の対応 */
const TIER_LABELS: Readonly<Record<string, string>> = { '1000': '1', '2000': '2', '3000': '3' }

/**
 * イベント種別ごとに通知から取り出した項目。文言の差し込みと条件の照合の両方に使う。
 *
 * userName は表示名（文言に差し込む）、userLogin はTwitchのユーザー名（user の条件と照らし合わせる）。
 * 表示名は配信者が変えられるため、条件の照合には変わらない userLogin を使う。
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

const isRecord = (value: unknown): value is EventBody => typeof value === 'object' && value !== null

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
  if (!isRecord(reward)) throw new Error('チャンネルポイント交換の通知に reward がありません')
  const { id, title } = reward
  if (typeof id !== 'string' || typeof title !== 'string') throw new Error('チャンネルポイント交換の通知の reward に id または title がありません')
  return { rewardId: id, rewardTitle: title }
}

/**
 * 通知から、照合と文言に使う項目をイベント種別ごとに取り出す。
 *
 * @param subscriptionType 通知の subscription.type
 * @param body 通知の event（中身）
 * @returns アラートに使えないイベント種別なら null（配信の開始・終了やチャットもここへ来るため、例外にしない）
 * @throws 通知の中身が想定した形でない場合
 */
export const extract = (subscriptionType: string, body: unknown): Extracted | null => {
  if (!isRecord(body)) throw new Error('イベントの通知に中身がありません')

  switch (subscriptionType) {
    case REDEMPTION:
      return { event: REDEMPTION, userName: readString(body, 'user_name'), userLogin: readString(body, 'user_login'), ...readReward(body) }
    case FOLLOW:
      return { event: FOLLOW, userName: readString(body, 'user_name'), userLogin: readString(body, 'user_login') }
    case SUBSCRIBE:
      return { event: SUBSCRIBE, userName: readString(body, 'user_name'), userLogin: readString(body, 'user_login'), tier: readString(body, 'tier') }
    case SUBSCRIPTION_MESSAGE:
      return {
        event: SUBSCRIPTION_MESSAGE,
        userName: readString(body, 'user_name'),
        userLogin: readString(body, 'user_login'),
        tier: readString(body, 'tier'),
        cumulativeMonths: readNumber(body, 'cumulative_months'),
      }
    // レイドは通知を受け取る側（配信者）が to_broadcaster なので、レイドした配信者は from_broadcaster に入る
    case RAID:
      return {
        event: RAID,
        userName: readString(body, 'from_broadcaster_user_name'),
        userLogin: readString(body, 'from_broadcaster_user_login'),
        viewers: readNumber(body, 'viewers'),
      }
    default:
      return null
  }
}

/**
 * 条件1件が、取り出した項目を満たすか。
 *
 * reward の条件はチャンネルポイントの交換にしか意味を持たないため、ほかのイベントでは満たさないものとして扱う
 * （保存時にも拒否しているが、照合でも通さない。古い設定が残っていても、意図しないイベントでアラートが出ないようにする）。
 * user の条件は大文字小文字を区別しない（Twitchのユーザー名は小文字だが、配信者が表示名の綴りで入れても当てられるようにする）。
 */
const satisfiesCondition = (condition: StoredCondition, extracted: Extracted): boolean => {
  switch (condition.kind) {
    case 'reward':
      return extracted.event === REDEMPTION && condition.rewardId === extracted.rewardId
    case 'user':
      return condition.login.toLowerCase() === extracted.userLogin.toLowerCase()
  }
}

/** トリガーが、取り出した項目に当てはまるか。イベント種別が同じで、条件をすべて満たすときに当てはまる（and） */
export const matches = (trigger: StoredTrigger, extracted: Extracted): boolean =>
  trigger.event === extracted.event && trigger.conditions.every((condition) => satisfiesCondition(condition, extracted))

/**
 * ティアの表記。Twitchが返す "1000" などを 1 に直す。
 *
 * 注意: 対応表にない値はそのまま出す。Twitchがティアを増やした場合に、文言だけ崩れても応答は続けるため。
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
 * 通知に当てはまるトリガーを探し、その動作の文言に差し込み語を置き換えて返す。
 *
 * @param actionOf トリガーから目的の動作を取り出す関数。この動作を持つトリガーだけが対象で、
 *   複数当てはまる場合は先に書かれたものを使う（当てはまるだけ送るとチャットを連投し、Twitchの送信のレート制限にもかかるため）
 * @returns 文言を置き換えた動作。アラートに使えないイベント種別、または当てはまるトリガーがなければ null
 * @throws 通知の中身が想定した形でない場合（その動作を持つトリガーがあるイベント種別に限る）
 */
const filledActionFor = <Action extends { message: string }>(
  config: AlertConfig,
  subscriptionType: string,
  body: unknown,
  actionOf: (trigger: StoredTrigger) => Action | null,
): Action | null => {
  // その動作を持つトリガーが1件もないイベント種別なら、通知の中身は読まない。
  // 設定していないイベントの中身の形が想定と違うだけで、配信の記録まで止めてしまわないため
  const candidates = config.triggers.filter((trigger) => trigger.event === subscriptionType && actionOf(trigger) !== null)
  if (candidates.length === 0) return null

  const extracted = extract(subscriptionType, body)
  if (extracted === null) return null

  for (const trigger of candidates) {
    if (!matches(trigger, extracted)) continue
    const action = actionOf(trigger)
    if (action !== null) return { ...action, message: fillMessage(action.message, extracted) }
  }
  return null
}

/**
 * 通知に当てはまるトリガーを探し、チャットへ送る文言を決める。
 *
 * @returns 送る文言。当てはまるトリガーがなければ null
 * @throws 通知の中身が想定した形でない場合（チャットに送るトリガーがあるイベント種別に限る）
 */
export const chatMessageFor = (config: AlertConfig, subscriptionType: string, body: unknown): string | null =>
  filledActionFor(config, subscriptionType, body, chatActionOf)?.message ?? null

/**
 * 通知に当てはまるトリガーを探し、送るアナウンス（文言と色）を決める。
 *
 * 選び方は chatMessageFor と同じで、複数当てはまる場合は先に書かれたものを使う。
 *
 * @returns 送るアナウンス。当てはまるトリガーがなければ null
 * @throws 通知の中身が想定した形でない場合（アナウンスを送るトリガーがあるイベント種別に限る）
 */
export const announcementFor = (config: AlertConfig, subscriptionType: string, body: unknown): StoredAnnounceAction | null =>
  filledActionFor(config, subscriptionType, body, announceActionOf)
