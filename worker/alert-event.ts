/**
 * アラートのイベントの読み取り
 *
 * Twitchから届いた通知の中身から、条件の照合と文言の差し込みに使う項目をイベント種別ごとに取り出し、
 * トリガーの一覧と照らし合わせて「何をするか」を決める（送信と再生そのものは呼び出し側が行う）。
 * 動作の種類ごとに入口が分かれているが、呼ぶのはどれもWebhookの受け口（webhook-routes.ts）である。
 * chatMessageFor・announcementFor の結果はWorkerがbotとして送り、alertFor の結果はオーバーレイへ押し出す。
 *
 * 照合はこのファイルだけが持つ。オーバーレイ（src/alerts/）は押し出されてきたアラートを再生するだけで、
 * トリガーも条件も知らない。Twitchからの通知はすべてWebhookでWorkerに届くので、オーバーレイが照合に要る材料
 * （とくに「その配信で初めての発言か」のようにデータベースの記録からしか決まらないもの）を持つ必要はない。
 *
 * 条件の種類には、そのイベントにしか意味を持たないものがある（reward はチャンネルポイントの交換、
 * text・firstChatOfStream・firstChatEver・returningAfter はチャットの発言）。ほかのイベントでは満たさないものとして扱う
 * （保存時にも拒否しているが、古い設定が残っていても意図しないイベントで動かないようにする）。
 */
import {
  alertActionOf,
  announceActionOf,
  chatActionOf,
  mediaPath,
  type AlertConfig,
  type MediaKind,
  type StoredAnnounceAction,
  type StoredCondition,
  type StoredTrigger,
} from './alert-config'
import { readChatMessage } from './chat-command'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
const FOLLOW = 'channel.follow'
const SUBSCRIBE = 'channel.subscribe'
const SUBSCRIPTION_MESSAGE = 'channel.subscription.message'
const RAID = 'channel.raid'
const CHAT_MESSAGE = 'channel.chat.message'

/**
 * Twitchへ送る1通の上限（チャットもアナウンスも500文字。worker/alert-config.ts の検証と同じ値）。
 *
 * 保存時に文言そのものは500文字以内に収めているが、{message}（発言の本文。最大500文字）を差し込むと超えることがある。
 */
const MAX_CHAT_MESSAGE_LENGTH = 500

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
  | { readonly event: typeof CHAT_MESSAGE; readonly userName: string; readonly userLogin: string; readonly text: string }

/**
 * 通知の中身だけでは決まらない条件の判定結果。呼び出し側（worker/alert-state.ts）が先に調べて渡す。
 *
 * 照合（matches）を通信も時刻も持たない純粋な関数のままにするために、こうして値で受け取る形にしている
 * （worker/chat-moderation.ts の judge が連投の件数を引数で受け取っているのと同じ作り）。
 */
export interface ConditionState {
  /** その配信で初めての発言か。発言以外のイベントでは false を渡す */
  readonly firstChatOfStream: boolean
  /** このチャンネルで初めての発言か。発言以外のイベントでは false を渡す */
  readonly firstChatEver: boolean
  /** その発言が、前の発言から何日空いていたか。このチャンネルで初めての発言と、発言以外のイベントでは null を渡す */
  readonly daysSinceLastChat: number | null
}

/** そのイベントのトリガーに、指定した種類の条件がひとつでも使われているか */
const uses = (config: AlertConfig, subscriptionType: string, kinds: readonly StoredCondition['kind'][]): boolean =>
  config.triggers.some((trigger) => trigger.event === subscriptionType && trigger.conditions.some((condition) => kinds.includes(condition.kind)))

/**
 * その通知の照合に、「その配信で初めての発言か」の判定が要るか。
 *
 * 要らなければ呼び出し側はデータベースを触らずに済む。チャットの発言は件数の桁が違うため、
 * 1通ごとにD1へ書き込まないようにこれで絞る。
 */
export const requiresFirstChatOfStream = (config: AlertConfig, subscriptionType: string): boolean => uses(config, subscriptionType, ['firstChatOfStream'])

/**
 * その通知の照合に、視聴者の記録（viewers）から決まる判定が要るか。
 *
 * 「このチャンネルで初めての発言か」（firstChatEver）と「最後の発言から何日空いているか」（returningAfter）は
 * どちらも viewers の同じ1行から決まるので、まとめて1つの読み出しで済ませられる。
 * どちらも使っていなければ、呼び出し側はその読み出しを省ける。
 */
export const requiresChatHistory = (config: AlertConfig, subscriptionType: string): boolean =>
  uses(config, subscriptionType, ['firstChatEver', 'returningAfter'])

/**
 * その通知に、オーバーレイへ押し出すアラートを持つトリガーがあるか。
 *
 * 無ければ呼び出し側（webhook-routes.ts）はオーバーレイ用キーを読みに行かずに済む。
 * チャットの発言は件数の桁が違うため、1通ごとに余分なKVの読み出しを増やさないようにこれで絞る。
 */
export const hasAlertAction = (config: AlertConfig, subscriptionType: string): boolean =>
  config.triggers.some((trigger) => trigger.event === subscriptionType && alertActionOf(trigger) !== null)

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
 * @returns アラートに使えないイベント種別なら null（配信の開始・終了もここへ来るため、例外にしない）
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
    // 発言の読み取りはチャットボットと同じものを使う（同じ通知を2か所で読み解かないため）
    case CHAT_MESSAGE: {
      const message = readChatMessage(body)
      return { event: CHAT_MESSAGE, userName: message.chatterUserName, userLogin: message.chatterUserLogin, text: message.text }
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
const satisfiesCondition = (condition: StoredCondition, extracted: Extracted, state: ConditionState): boolean => {
  switch (condition.kind) {
    case 'reward':
      return extracted.event === REDEMPTION && condition.rewardId === extracted.rewardId
    case 'user':
      return condition.login.toLowerCase() === extracted.userLogin.toLowerCase()
    case 'text':
      // 本文を持つのはチャットの発言だけなので、ほかのイベントでは満たさないものとして扱う（reward と同じ扱い）
      return extracted.event === CHAT_MESSAGE && extracted.text.toLowerCase().includes(condition.contains.toLowerCase())
    case 'firstChatOfStream':
      // 判定そのものは呼び出し側（worker/alert-state.ts）が済ませている。ここでは受け取った結果を見るだけ。
      // 発言以外のイベントでは意味を持たないので、ほかのイベントでは満たさないものとして扱う（text と同じ扱い）
      return extracted.event === CHAT_MESSAGE && state.firstChatOfStream
    // 判定は firstChatOfStream と同じく呼び出し側（worker/alert-state.ts）が済ませている
    case 'firstChatEver':
      return extracted.event === CHAT_MESSAGE && state.firstChatEver
    // 初めての発言では空いた日数が決まらない（null）ので、当てはまらないものとして扱う
    case 'returningAfter':
      return extracted.event === CHAT_MESSAGE && state.daysSinceLastChat !== null && state.daysSinceLastChat >= condition.days
  }
}

/** トリガーが、取り出した項目に当てはまるか。イベント種別が同じで、条件をすべて満たすときに当てはまる（and） */
export const matches = (trigger: StoredTrigger, extracted: Extracted, state: ConditionState): boolean =>
  trigger.event === extracted.event && trigger.conditions.every((condition) => satisfiesCondition(condition, extracted, state))

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
    case CHAT_MESSAGE:
      return { '{user}': extracted.userName, '{message}': extracted.text }
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
  state: ConditionState,
): Action | null => {
  // その動作を持つトリガーが1件もないイベント種別なら、通知の中身は読まない。
  // 設定していないイベントの中身の形が想定と違うだけで、配信の記録まで止めてしまわないため
  const candidates = config.triggers.filter((trigger) => trigger.event === subscriptionType && actionOf(trigger) !== null)
  if (candidates.length === 0) return null

  const extracted = extract(subscriptionType, body)
  if (extracted === null) return null

  for (const trigger of candidates) {
    if (!matches(trigger, extracted, state)) continue
    const action = actionOf(trigger)
    if (action !== null) return { ...action, message: fillMessage(action.message, extracted) }
  }
  return null
}

/**
 * 通知に当てはまるトリガーを探し、チャットへ送る文言を決める。
 *
 * 差し込みの結果がTwitchの上限（500文字）を超えていれば、末尾を … にして収める。
 *
 * @returns 送る文言。当てはまるトリガーがなければ null
 * @throws 通知の中身が想定した形でない場合（チャットに送るトリガーがあるイベント種別に限る）
 */
/**
 * Twitchへ送る文言を上限に収める。超えていれば末尾を … にする。
 *
 * 上限を超えたままではTwitchが1通まるごと拒み、お礼がまったく送られない（`alert-chat-failed` として記録されるだけになる）。
 * 切れていることが配信者に分かるよう、黙って切らずに末尾へ … を付ける。
 */
const withinChatLimit = (message: string): string =>
  message.length <= MAX_CHAT_MESSAGE_LENGTH ? message : `${message.slice(0, MAX_CHAT_MESSAGE_LENGTH - 1)}…`

export const chatMessageFor = (config: AlertConfig, subscriptionType: string, body: unknown, state: ConditionState): string | null => {
  const action = filledActionFor(config, subscriptionType, body, chatActionOf, state)
  return action === null ? null : withinChatLimit(action.message)
}

/**
 * 通知に当てはまるトリガーを探し、送るアナウンス（文言と色）を決める。
 *
 * 選び方と上限への収め方は chatMessageFor と同じで、複数当てはまる場合は先に書かれたものを使う。
 *
 * @returns 送るアナウンス。当てはまるトリガーがなければ null
 * @throws 通知の中身が想定した形でない場合（アナウンスを送るトリガーがあるイベント種別に限る）
 */
export const announcementFor = (config: AlertConfig, subscriptionType: string, body: unknown, state: ConditionState): StoredAnnounceAction | null => {
  const action = filledActionFor(config, subscriptionType, body, announceActionOf, state)
  return action === null ? null : { ...action, message: withinChatLimit(action.message) }
}

/** オーバーレイが再生するアラート1件（src/alerts/resolve.ts の Alert に対応する） */
export interface OverlayAlert {
  media: { kind: MediaKind; url: string }
  durationSeconds: number
  volume: number
  /** 画面に出す文言。差し込み語を置き換えたあとの文字列。空文字なら文言を出さない */
  text: string
}

/**
 * 通知に当てはまるトリガーを探し、オーバーレイが再生するアラートを決める。
 *
 * 照合をここ（Worker）で行うのは、条件に「その配信で初めての発言か」のようにデータベースの記録から決まるものがあり、
 * オーバーレイでは判定できないためである。オーバーレイは通知をそのまま送ってきて、返ってきたアラートを再生するだけでよい。
 *
 * @param overlayKey 素材のURLに付けるオーバーレイ用キー（キーが違えば素材の取得をWorkerが拒否する）
 * @returns 再生するアラート。当てはまるトリガーがなければ null
 * @throws 通知の中身が想定した形でない場合（アラートを出すトリガーがあるイベント種別に限る）
 */
export const alertFor = (
  config: AlertConfig,
  subscriptionType: string,
  body: unknown,
  overlayKey: string,
  state: ConditionState,
): OverlayAlert | null => {
  const action = filledActionFor(config, subscriptionType, body, alertActionOf, state)
  if (action === null) return null

  return {
    media: { kind: action.mediaKind, url: mediaPath(action.mediaId, overlayKey) },
    durationSeconds: action.durationSeconds,
    volume: action.volume,
    text: action.message,
  }
}
