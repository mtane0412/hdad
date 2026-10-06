/**
 * アラートのイベントの読み取り
 *
 * Twitchから届いた通知の中身から、条件の照合と文言の差し込みに使う項目をイベント種別ごとに取り出し、
 * トリガーの一覧と照らし合わせて「何をするか」を決める（送信と再生そのものは呼び出し側が行う）。
 * 動作の種類ごとに入口が分かれているが、呼ぶのはどれもWebhookの受け口（webhook-routes.ts）である。
 * chatMessageFor・announcementFor の結果はWorkerがbotとして送り、alertFor の結果はオーバーレイへ押し出す。
 * aiChatFor だけは送る文言ではなく「文面の作り方の指示」を返し、文面づくりは worker/ai-chat.ts が受け持つ。
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
  aiChatActionOf,
  alertActionOf,
  announceActionOf,
  chatActionOf,
  mediaPath,
  shoutoutActionOf,
  townTourActionOf,
  twisterActionOf,
  type AlertConfig,
  type MediaKind,
  type StoredAiChatAction,
  type StoredAnnounceAction,
  resolveTrigger,
  type ResolvedTrigger,
} from './alert-config'
import { readChatMessage } from './chat-command'
import { BRANCH_REF_PREFIX } from './github-webhook'
import { GREETING_KINDS, isGreeting, type StoredCondition } from './trigger-menu'
import { fillStreamSummary, STREAM_SUMMARY_PLACEHOLDER } from './stream-summary'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
const FOLLOW = 'channel.follow'
const SUBSCRIBE = 'channel.subscribe'
const SUBSCRIPTION_MESSAGE = 'channel.subscription.message'
const RAID = 'channel.raid'
const CHAT_MESSAGE = 'channel.chat.message'
const AD_BREAK_BEGIN = 'channel.ad_break.begin'
const AD_BREAK_END = 'channel.ad_break.end'
const GITHUB_PUSH = 'github.push'
const GITHUB_PULL_REQUEST_MERGED = 'github.pull_request.merged'
const POMODORO_WORK_BEGIN = 'hdad.pomodoro.work_begin'
const POMODORO_BREAK_BEGIN = 'hdad.pomodoro.break_begin'

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
  // userId はレイドしてきた配信者のユーザーID。シャウトアウト（相手の配信者を紹介する）を送る宛先に要る
  | {
      readonly event: typeof RAID
      readonly userId: string
      readonly userName: string
      readonly userLogin: string
      readonly viewers: number
      /** レイドを受け取った配信者の表示名（ツイスターで対戦する配信者の名前に使う。issue #272） */
      readonly broadcasterName: string
    }
  | { readonly event: typeof CHAT_MESSAGE; readonly userName: string; readonly userLogin: string; readonly text: string }
  // 広告の開始と終了。userName・userLogin は広告を打った人（自動で入った広告では配信者自身が入る）
  | {
      readonly event: typeof AD_BREAK_BEGIN | typeof AD_BREAK_END
      readonly userName: string
      readonly userLogin: string
      readonly durationSeconds: number
      readonly automatic: boolean
    }
  // GitHub から届く開発の出来事。userName・userLogin はどちらも GitHub のユーザー名（push は pusher.name、PRのマージは sender.login）で、Twitchのユーザーではない。
  // commitMessage は最後のコミット（head_commit）のメッセージの1行目だけ（2行目以降の本文は配信に出さない）
  | {
      readonly event: typeof GITHUB_PUSH
      readonly userName: string
      readonly userLogin: string
      readonly repository: string
      readonly branch: string
      readonly commitMessage: string
    }
  | {
      readonly event: typeof GITHUB_PULL_REQUEST_MERGED
      readonly userName: string
      readonly userLogin: string
      readonly repository: string
      readonly title: string
      readonly number: number
    }
  // ポモドーロの区切り。視聴者の行動ではないので、相手（userName・userLogin）を持たない。
  // round は何本目か（休憩は直前の作業と同じ番号）、minutes は始まった区間の長さ（分）
  | { readonly event: typeof POMODORO_WORK_BEGIN | typeof POMODORO_BREAK_BEGIN; readonly round: number; readonly minutes: number }

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

/**
 * その通知のイベント種別を対象にするトリガーを、照合に使う形へ展開して取り出す。
 *
 * 保存されているのは既定メニューの項目（kind とパラメータ）なので、イベント種別と条件はここで展開する
 * （展開は通信も時刻も持たない純粋な処理なので、必要になったその場で行ってよい）。
 */
const triggersFor = (config: AlertConfig, subscriptionType: string): ResolvedTrigger[] =>
  config.triggers.map(resolveTrigger).filter((trigger) => trigger.event === subscriptionType)

/** そのイベントのトリガーに、指定した種類の条件がひとつでも使われているか */
const uses = (config: AlertConfig, subscriptionType: string, kinds: readonly StoredCondition['kind'][]): boolean =>
  triggersFor(config, subscriptionType).some((trigger) => trigger.conditions.some((condition) => kinds.includes(condition.kind)))

/**
 * そのイベントに、LLMへ文面を作らせる動作（aiChat）を持つトリガーがあるか。
 *
 * この動作は条件の有無にかかわらず、来訪の別（初めて・お久しぶり）を文面づくりの材料として読む。
 * 条件としては使っていなくても判定が要るのはこの動作だけなので、requires* から見分けられるようにしておく。
 */
const hasAiChatAction = (config: AlertConfig, subscriptionType: string): boolean =>
  triggersFor(config, subscriptionType).some((trigger) => aiChatActionOf(trigger) !== null)

/**
 * その通知に、「その配信で初めての発言か」の判定が要るか。
 *
 * 要らなければ呼び出し側はデータベースを触らずに済む。チャットの発言は件数の桁が違うため、
 * 1通ごとにD1へ書き込まないようにこれで絞る。
 *
 * 条件（firstChatOfStream）として使っている場合のほかに、LLMへ文面を作らせる動作（aiChat）がある場合も要る。
 * aiChat は条件を1件も持たないトリガーでも「初めての人か」で文面を変えるのが主な使い道なので、
 * 条件に書かれていなくても判定して材料に渡す（渡さないと、来訪の別を知らないまま文面を作らせることになる）。
 */
export const requiresFirstChatOfStream = (config: AlertConfig, subscriptionType: string): boolean =>
  uses(config, subscriptionType, ['firstChatOfStream']) || hasAiChatAction(config, subscriptionType)

/**
 * その通知に、視聴者の記録（viewers）から決まる判定が要るか。
 *
 * 「このチャンネルで初めての発言か」（firstChatEver）と「最後の発言から何日空いているか」（returningAfter）は
 * どちらも viewers の同じ1行から決まるので、まとめて1つの読み出しで済ませられる。
 * どちらも使っておらず、LLMへ文面を作らせる動作もなければ、呼び出し側はその読み出しを省ける。
 */
export const requiresChatHistory = (config: AlertConfig, subscriptionType: string): boolean =>
  uses(config, subscriptionType, ['firstChatEver', 'returningAfter']) || hasAiChatAction(config, subscriptionType)

/**
 * その通知に、オーバーレイへ押し出すアラートを持つトリガーがあるか。
 *
 * 無ければ呼び出し側（webhook-routes.ts）はオーバーレイ用キーを読みに行かずに済む。
 * チャットの発言は件数の桁が違うため、1通ごとに余分なKVの読み出しを増やさないようにこれで絞る。
 */
export const hasAlertAction = (config: AlertConfig, subscriptionType: string): boolean =>
  triggersFor(config, subscriptionType).some((trigger) => alertActionOf(trigger) !== null)

/**
 * その通知に、配信のあらすじが要るトリガーがあるか。
 *
 * 無ければ呼び出し側（webhook-routes.ts）はあらすじをデータベースから読まずに済む
 * （requiresFirstChatOfStream・requiresChatHistory と同じ要否の判定で、チャットの発言では1通ごとにここを通るため）。
 * 要るのは2通りで、文言を持つ動作（alert・chat・announce）が差し込み語 {summary} を含む場合と、
 * 文面をLLMに作らせる動作（aiChat）がある場合である。後者は文言を持たないが、話の流れを知らないまま
 * 文面を作らせないよう、指示に書かれていなくても材料として渡す（requiresChatHistory が来訪の別を必ず調べるのと同じ）。
 */
export const requiresStreamSummary = (config: AlertConfig, subscriptionType: string): boolean =>
  triggersFor(config, subscriptionType).some((trigger) =>
    trigger.actions.some((action) => 'message' in action && action.message.includes(STREAM_SUMMARY_PLACEHOLDER)),
  ) || hasAiChatAction(config, subscriptionType)

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

/** イベントの中身から真偽値の項目を読む */
const readBoolean = (event: EventBody, key: string): boolean => {
  const value = event[key]
  if (typeof value !== 'boolean') throw new Error(`イベントの通知に ${key} がありません`)
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

/** 通知の中身の、入れ子のオブジェクトを読む。無ければどの項目が欠けているかを示してエラーにする */
const readRecord = (event: EventBody, key: string): EventBody => {
  const value = event[key]
  if (!isRecord(value)) throw new Error(`イベントの通知に ${key} がありません`)
  return value
}

/**
 * GitHub の通知から、どの出来事でも共通に使う項目（GitHub のユーザー名とリポジトリ名）を読む。
 *
 * リポジトリは owner を含まない名前（name）を使う。Webhook を設定するのは配信者自身のリポジトリなので、
 * owner は配信者で決まっており、配信に出すには短い名前のほうが読みやすいためである。
 *
 * @param login その出来事を起こした人の GitHub のユーザー名。どこに入っているかは出来事ごとに違うので、呼び出し側が読んで渡す
 */
const readGithubCommon = (event: EventBody, login: string): { userName: string; userLogin: string; repository: string } => ({
  userName: login,
  userLogin: login,
  repository: readString(readRecord(event, 'repository'), 'name'),
})

/** コミットのメッセージの1行目。2行目以降（本文）は長く、配信に出す文言に向かないので落とす */
const firstLineOf = (message: string): string => message.split('\n')[0] ?? ''

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
        userId: readString(body, 'from_broadcaster_user_id'),
        userName: readString(body, 'from_broadcaster_user_name'),
        userLogin: readString(body, 'from_broadcaster_user_login'),
        viewers: readNumber(body, 'viewers'),
        broadcasterName: readString(body, 'to_broadcaster_user_name'),
      }
    // 発言の読み取りはチャットボットと同じものを使う（同じ通知を2か所で読み解かないため）
    case CHAT_MESSAGE: {
      const message = readChatMessage(body)
      return { event: CHAT_MESSAGE, userName: message.chatterUserName, userLogin: message.chatterUserLogin, text: message.text }
    }
    // 広告の終了はTwitchから届かない擬似イベントで、開始と同じ中身をWorkerが渡してくる（worker/ad-break-timer.ts）。
    // そのため読み取り方も開始と同じにする
    case AD_BREAK_BEGIN:
    case AD_BREAK_END:
      return {
        event: subscriptionType,
        userName: readString(body, 'requester_user_name'),
        userLogin: readString(body, 'requester_user_login'),
        durationSeconds: readNumber(body, 'duration_seconds'),
        automatic: readBoolean(body, 'is_automatic'),
      }
    // GitHub の出来事は、受け口（worker/github-routes.ts）が push・PRのマージだけに振り分けてから渡してくる。
    // タグの push とブランチの削除はそこで外してあるので、ref は必ず refs/heads/ で始まり、head_commit も必ずある
    case GITHUB_PUSH:
      return {
        event: GITHUB_PUSH,
        // push の通知では sender が省略されうるので、必ずある pusher.name（pushした人の GitHub のユーザー名）を読む
        ...readGithubCommon(body, readString(readRecord(body, 'pusher'), 'name')),
        branch: readString(body, 'ref').replace(BRANCH_REF_PREFIX, ''),
        commitMessage: firstLineOf(readString(readRecord(body, 'head_commit'), 'message')),
      }
    case GITHUB_PULL_REQUEST_MERGED: {
      const pullRequest = readRecord(body, 'pull_request')
      return {
        event: GITHUB_PULL_REQUEST_MERGED,
        // PR の closed では sender がマージした人になる
        ...readGithubCommon(body, readString(readRecord(body, 'sender'), 'login')),
        title: readString(pullRequest, 'title'),
        number: readNumber(pullRequest, 'number'),
      }
    }
    // ポモドーロの区切りはWorkerのタイマー（worker/pomodoro-timer.ts）が作る擬似イベントで、中身もそこが作る
    case POMODORO_WORK_BEGIN:
    case POMODORO_BREAK_BEGIN:
      return { event: subscriptionType, round: readNumber(body, 'round'), minutes: readNumber(body, 'minutes') }
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
    // 相手を持たない出来事（ポモドーロの区切り）では満たさないものとして扱う（reward と同じ扱い）
    case 'user':
      return 'userLogin' in extracted && condition.login.toLowerCase() === extracted.userLogin.toLowerCase()
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
    // 自動か手動かを持つのは広告だけなので、ほかのイベントでは満たさないものとして扱う（reward と同じ扱い）
    case 'automatic':
      return (extracted.event === AD_BREAK_BEGIN || extracted.event === AD_BREAK_END) && extracted.automatic === condition.automatic
  }
}

/**
 * 展開したトリガーが、取り出した項目に当てはまるか。イベント種別が同じで、条件をすべて満たすときに当てはまる（and）。
 *
 * 受け取るのは展開後の形（ResolvedTrigger）である。既定メニューの項目から条件を作るのは worker/trigger-menu.ts の
 * 役目で、当てはまるかどうかの判定はこの関数だけが持つ（判定を2か所に置かないため）。
 */
export const matches = (trigger: ResolvedTrigger, extracted: Extracted, state: ConditionState): boolean =>
  trigger.event === extracted.event && trigger.conditions.every((condition) => satisfiesCondition(condition, extracted, state))

/**
 * ティアの表記。Twitchが返す "1000" などを 1 に直す。
 *
 * 注意: 対応表にない値はそのまま出す。Twitchがティアを増やした場合に、文言だけ崩れても応答は続けるため。
 */
const tierLabel = (tier: string): string => TIER_LABELS[tier] ?? tier

/** 文言の中の差し込み語らしい部分（{英小文字}）。そのイベントに無い語は置き換えずに残す（fillMessage） */
const PLACEHOLDER_PATTERN = /\{[a-z]+\}/g

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
    // 広告の長さは秒で差し込む（Twitchが秒で知らせてくるので、分に丸めずそのまま出す）
    case AD_BREAK_BEGIN:
    case AD_BREAK_END:
      return { '{user}': extracted.userName, '{duration}': String(extracted.durationSeconds) }
    // {message} はチャットの発言と同じ語を使う（どちらも「その出来事の本文」で、配信者が覚える語を増やさない）
    case GITHUB_PUSH:
      return { '{user}': extracted.userName, '{repo}': extracted.repository, '{branch}': extracted.branch, '{message}': extracted.commitMessage }
    case GITHUB_PULL_REQUEST_MERGED:
      return { '{user}': extracted.userName, '{repo}': extracted.repository, '{title}': extracted.title, '{number}': String(extracted.number) }
    // 相手がいないので {user} は持たない（書かれていれば置き換えずに残し、配信者が誤りに気付けるようにする）
    case POMODORO_WORK_BEGIN:
    case POMODORO_BREAK_BEGIN:
      return { '{round}': String(extracted.round), '{minutes}': String(extracted.minutes) }
  }
}

/**
 * 文言の差し込み語を置き換える。そのイベントに存在しない語は、配信者が入力の誤りに気付けるよう置き換えずに残す。
 *
 * あらすじ（{summary}）だけはイベント種別によらず使える。通知の中身ではなく配信の状態から決まる語だからである。
 * 値をデータベースから読むのは呼び出し側（webhook-routes.ts）で、ここは受け取った値を差し込むだけにして
 * 純粋な関数のままにしておく（ConditionState を alert-state.ts が用意するのと同じ作り）。
 *
 * 注意: 置き換える値は関数で渡す。文字列で渡すと `$&` などが置換の特殊な指定として解釈され、
 * 報酬名にそうした文字が含まれるときに意図しない文言になる。
 * 注意: 文言は1回だけ走査して置き換える。語ごとに順に置き換えると、差し込んだ値（視聴者の発言や
 * LLMが書いたあらすじ）に含まれる差し込み語まで置き換えてしまう。視聴者が {summary} を並べるだけで
 * アラート文が際限なく長くなるため（chat-command.ts の applyReply と同じ作り）。
 *
 * @param summary 貯めてある配信のあらすじ。配信していない・まだ作っていない・読む必要がない場合は null で、
 *   そのときは「まだあらすじがありません」が入る（stream-summary.ts）
 */
export const fillMessage = (template: string, extracted: Extracted, summary: string | null): string => {
  const values = placeholderValues(extracted)
  return template.replaceAll(PLACEHOLDER_PATTERN, (placeholder) => {
    if (placeholder === STREAM_SUMMARY_PLACEHOLDER) return fillStreamSummary(placeholder, summary)
    return values[placeholder] ?? placeholder
  })
}

/**
 * 挨拶の段に当てはまったもののうち、最も細かい1つだけを残す。
 *
 * 初めて来た人の発言は必ず「その配信で最初の発言」でもあるので、すべて発動させると同じ1通に挨拶が二重に飛ぶ。
 * 優先順位は worker/trigger-menu.ts の GREETING_KINDS の並び（細かい順）で決め、保存されている並びには頼らない
 * （KVを手で直しても挨拶が入れ替わらないようにする）。挨拶以外の項目はすべてそのまま残す。
 */
const applyGreetingRule = (triggers: readonly ResolvedTrigger[]): ResolvedTrigger[] => {
  const winner = triggers
    .filter((trigger) => isGreeting(trigger.kind))
    .sort((left, right) => GREETING_KINDS.indexOf(left.kind) - GREETING_KINDS.indexOf(right.kind))[0]
  return triggers.filter((trigger) => !isGreeting(trigger.kind) || trigger === winner)
}

/**
 * 通知に当てはまるトリガーをすべて探す。
 *
 * **当てはまった行はすべて実行する。** 先に当てはまった1件だけを採ると、管理画面に固定で並ぶ行のうち
 * 絞り込みの緩いもの（「すべての発言」）が細かいもの（「初めて来た人の発言」）を飲み込み、
 * 下の行が永久に動かないまま設定だけが残ってしまう。ただし挨拶の段だけは例外で、
 * 当てはまったうちの1つに絞る（applyGreetingRule）。
 *
 * 動作の種類ごとに選び直さず1回で決めるのは、挨拶の絞り込みが動作の種類をまたぐためである
 * （「初めて来た人の発言 → AIチャット」と「その配信で最初の発言 → チャット」が並んでいるとき、
 * 動作ごとに選ぶと前者でAIチャットが、後者でチャットが送られて、挨拶が二重になる）。
 *
 * そのイベント種別のトリガーが1件もなければ通知の中身は読まない
 * （設定していないイベントの中身の形が想定と違うだけで、配信の記録まで止めてしまわないため）。
 *
 * @returns 当てはまったトリガーと読み取った中身。当てはまるものが無ければ null
 * @throws 通知の中身が想定した形でない場合（そのイベント種別のトリガーがある場合に限る）
 */
const matchedTriggers = (
  config: AlertConfig,
  subscriptionType: string,
  body: unknown,
  state: ConditionState,
): { triggers: ResolvedTrigger[]; extracted: Extracted } | null => {
  const candidates = triggersFor(config, subscriptionType)
  if (candidates.length === 0) return null

  const extracted = extract(subscriptionType, body)
  if (extracted === null) return null

  return { triggers: applyGreetingRule(candidates.filter((trigger) => matches(trigger, extracted, state))), extracted }
}

/**
 * 通知に当てはまるトリガーから、目的の種類の動作を並びの順に取り出す。
 *
 * @param actionOf トリガーから目的の動作を取り出す関数。この動作を持たないトリガーは飛ばす
 * @returns 文言を置き換える前の動作と、読み取った通知の中身の組を、トリガーの並びの順に返す
 * @throws 通知の中身が想定した形でない場合（そのイベント種別のトリガーがある場合に限る）
 */
const matchedActionsFor = <Action>(
  config: AlertConfig,
  subscriptionType: string,
  body: unknown,
  actionOf: (trigger: ResolvedTrigger) => Action | null,
  state: ConditionState,
): { action: Action; extracted: Extracted }[] => {
  const matched = matchedTriggers(config, subscriptionType, body, state)
  if (matched === null) return []

  return matched.triggers.flatMap((trigger) => {
    const action = actionOf(trigger)
    return action === null ? [] : [{ action, extracted: matched.extracted }]
  })
}

/**
 * 通知に当てはまるトリガーをすべて探し、その動作の文言に差し込み語を置き換えて返す。
 *
 * 文言を持つ動作（alert・chat・announce）のための入口で、文言を持たない aiChat は aiChatsFor が受け持つ。
 */
const filledActionsFor = <Action extends { message: string }>(
  config: AlertConfig,
  subscriptionType: string,
  body: unknown,
  actionOf: (trigger: ResolvedTrigger) => Action | null,
  state: ConditionState,
  summary: string | null,
): Action[] =>
  matchedActionsFor(config, subscriptionType, body, actionOf, state).map((matched) => ({
    ...matched.action,
    message: fillMessage(matched.action.message, matched.extracted, summary),
  }))

/**
 * 通知に当てはまるトリガーを探し、LLMに文面を作らせる材料（配信者の指示と、読み取ったイベントの中身）を返す。
 *
 * ほかの動作と違って文言を持たないので、差し込み語の置き換えはしない。文面づくりは worker/ai-chat.ts が受け持ち、
 * 相手の記録（viewers）は呼び出し側（webhook-routes.ts）が読んで追加する（このファイルは通信を持たないため）。
 *
 * @returns 指示と読み取った中身の組を、当てはまったトリガーの並びの順に返す
 * @throws 通知の中身が想定した形でない場合（この動作を持つトリガーがあるイベント種別に限る）
 */
export const aiChatsFor = (
  config: AlertConfig,
  subscriptionType: string,
  body: unknown,
  state: ConditionState,
): { instruction: StoredAiChatAction['instruction']; extracted: Extracted }[] =>
  matchedActionsFor(config, subscriptionType, body, aiChatActionOf, state).map((matched) => ({
    instruction: matched.action.instruction,
    extracted: matched.extracted,
  }))

/**
 * 通知に当てはまるトリガーを探し、シャウトアウト（相手の配信者を紹介する）を送る相手を返す。
 *
 * 文言を持たない動作なので差し込み語の置き換えはしない。相手はイベントの中身から決まる。
 * 置けるのはレイドのトリガーだけなので（worker/alert-config.ts の parseAlertConfig が保存時に拒む）、
 * ほかのイベントの通知でこの動作が見つかったら、黙って送らずに投げる（Fail-Fast。宛先にできる配信者がいないため）。
 *
 * @returns 紹介する相手を、当てはまったトリガーの並びの順に返す（userLogin は失敗を記録するときの手がかりに使う）
 * @throws 通知の中身が想定した形でない場合、またはレイド以外のトリガーにこの動作があった場合
 */
export const shoutoutsFor = (
  config: AlertConfig,
  subscriptionType: string,
  body: unknown,
  state: ConditionState,
): { userId: string; userLogin: string }[] =>
  matchedActionsFor(config, subscriptionType, body, shoutoutActionOf, state).map((matched) => {
    const { extracted } = matched
    if (extracted.event !== RAID) {
      throw new Error(`シャウトアウトはレイドのトリガーにだけ置けます（${extracted.event} のトリガーに置かれています）`)
    }
    return { userId: extracted.userId, userLogin: extracted.userLogin }
  })

/**
 * 市町村紹介を流したきっかけと相手。きっかけで冒頭の一文の言い回しが変わる（レイドは「レイドを記念して」、キーワードはダーツに見立てる）。
 * レイドはレイドの人数（viewers）も持ち、人口と比べる人数に足す（issue #250）
 */
export type TownTourTrigger =
  | { occasion: 'raid'; userName: string; userLogin: string; viewers: number }
  | { occasion: 'keyword'; userName: string; userLogin: string }

/**
 * チャットの発言を書いたのが、購読しているチャンネルの配信者本人か。
 *
 * 発言の読み取り（readChatMessage）の broadcasterUserId は、Shared Chat 中は書かれたチャンネルに置き換わるので使わず、
 * 通知そのものの broadcaster_user_id（購読しているチャンネル）と発言者を比べる（相手の配信者が相手のチャンネルで書いた発言を本人と取り違えない）。
 */
const isWrittenByBroadcaster = (body: unknown): boolean =>
  typeof body === 'object' &&
  body !== null &&
  'broadcaster_user_id' in body &&
  'chatter_user_id' in body &&
  typeof body.broadcaster_user_id === 'string' &&
  body.broadcaster_user_id === body.chatter_user_id &&
  !('source_broadcaster_user_id' in body && body.source_broadcaster_user_id !== null && body.source_broadcaster_user_id !== body.broadcaster_user_id)

/**
 * 通知に当てはまるトリガーを探し、市町村紹介を流すきっかけと、冒頭で名前を出す相手（表示名とログイン名）を返す（issue #229）。
 *
 * 置けるのはレイドとキーワードのトリガーだけなので（worker/alert-config.ts の parseAlertConfig が保存時に拒む）、
 * ほかのトリガーでこの動作が見つかったら、黙って流さずに投げる（Fail-Fast。冒頭の一文を組み立てられないため）。
 * 引く市町村は呼び出し側が決める（このファイルは乱数を持たないため）。
 * キーワードは配信者本人の動作確認用なので、配信者本人でない人の発言では流さない（issue #275。本人をレイド元とみなして共通点まで流す）。
 *
 * @returns きっかけ（レイドかキーワードか）と相手の表示名・ログイン名（レイドはレイドの人数も）を、当てはまったトリガーの並びの順に返す
 * @throws 通知の中身が想定した形でない場合、またはレイドとキーワード以外のトリガーにこの動作があった場合
 */
export const townToursFor = (
  config: AlertConfig,
  subscriptionType: string,
  body: unknown,
  state: ConditionState,
): TownTourTrigger[] =>
  // 動作そのものは項目を持たないので、代わりにトリガーの項目（kind）を取り出して、きっかけの判定に使う
  matchedActionsFor(config, subscriptionType, body, (trigger) => (townTourActionOf(trigger) === null ? null : trigger.kind), state).flatMap(
    ({ action: kind, extracted }): TownTourTrigger[] => {
      if (kind === 'raid' && extracted.event === RAID) {
        return [{ occasion: 'raid', userName: extracted.userName, userLogin: extracted.userLogin, viewers: extracted.viewers }]
      }
      if (kind === 'keyword' && extracted.event === CHAT_MESSAGE) {
        return isWrittenByBroadcaster(body) ? [{ occasion: 'keyword', userName: extracted.userName, userLogin: extracted.userLogin }] : []
      }
      throw new Error(`市町村紹介はレイドとキーワードのトリガーにだけ置けます（${kind} のトリガーに置かれています）`)
    },
  )

/** ツイスターで対戦する2人（レイドした人と、レイドを受けた配信者） */
export interface TwisterTrigger {
  /** レイドした配信者のユーザーID（アイコンを引くのに使う） */
  readonly raiderId: string
  readonly raiderName: string
  /** レイドを受けた配信者の表示名 */
  readonly broadcasterName: string
}

/**
 * 通知に当てはまるトリガーを探し、ツイスターで対戦する2人を返す（issue #272）。
 *
 * 置けるのはレイドのトリガーだけなので（worker/alert-config.ts の parseAlertConfig が保存時に拒む）、
 * ほかのトリガーでこの動作が見つかったら、黙って流さずに投げる（Fail-Fast。対戦する相手が決まらないため）。
 * 対戦の種とアイコンは呼び出し側が決める（このファイルは乱数も通信も持たないため）。
 *
 * @returns 対戦する2人を、当てはまったトリガーの並びの順に返す
 * @throws 通知の中身が想定した形でない場合、またはレイド以外のトリガーにこの動作があった場合
 */
export const twistersFor = (config: AlertConfig, subscriptionType: string, body: unknown, state: ConditionState): TwisterTrigger[] =>
  matchedActionsFor(config, subscriptionType, body, (trigger) => (twisterActionOf(trigger) === null ? null : trigger.kind), state).map(
    ({ action: kind, extracted }) => {
      if (kind === 'raid' && extracted.event === RAID) {
        return { raiderId: extracted.userId, raiderName: extracted.userName, broadcasterName: extracted.broadcasterName }
      }
      throw new Error(`ツイスターはレイドのトリガーにだけ置けます（${kind} のトリガーに置かれています）`)
    },
  )

/**
 * 通知に当てはまるトリガーをすべて探し、チャットへ送る文言を決める。
 *
 * 差し込みの結果がTwitchの上限（500文字）を超えていれば、末尾を … にして収める。
 *
 * @returns 送る文言を、当てはまったトリガーの並びの順に返す
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

export const chatMessagesFor = (
  config: AlertConfig,
  subscriptionType: string,
  body: unknown,
  state: ConditionState,
  summary: string | null,
): string[] => filledActionsFor(config, subscriptionType, body, chatActionOf, state, summary).map((action) => withinChatLimit(action.message))

/**
 * 通知に当てはまるトリガーをすべて探し、送るアナウンス（文言と色）を決める。
 *
 * 選び方と上限への収め方は chatMessagesFor と同じで、当てはまった行はすべて返す。
 *
 * @returns 送るアナウンスを、当てはまったトリガーの並びの順に返す
 * @throws 通知の中身が想定した形でない場合（アナウンスを送るトリガーがあるイベント種別に限る）
 */
export const announcementsFor = (
  config: AlertConfig,
  subscriptionType: string,
  body: unknown,
  state: ConditionState,
  summary: string | null,
): StoredAnnounceAction[] =>
  filledActionsFor(config, subscriptionType, body, announceActionOf, state, summary).map((action) => ({
    ...action,
    message: withinChatLimit(action.message),
  }))

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
 * @returns 再生するアラートを、当てはまったトリガーの並びの順に返す（オーバーレイは受け取った順に並べて再生する）
 * @throws 通知の中身が想定した形でない場合（アラートを出すトリガーがあるイベント種別に限る）
 */
export const alertsFor = (
  config: AlertConfig,
  subscriptionType: string,
  body: unknown,
  overlayKey: string,
  state: ConditionState,
  summary: string | null,
): OverlayAlert[] =>
  filledActionsFor(config, subscriptionType, body, alertActionOf, state, summary).map((action) => ({
    media: { kind: action.mediaKind, url: mediaPath(action.mediaId, overlayKey) },
    durationSeconds: action.durationSeconds,
    volume: action.volume,
    text: action.message,
  }))
