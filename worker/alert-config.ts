/**
 * アラートの設定
 *
 * 「どのイベントで、何をするか」（トリガー）の一覧を、管理画面から受け取って検証し、ストア（KV）に保存する。
 * トリガーは「イベント種別」（event）と「条件のリスト」（conditions）と「動作」（actions）からなる。
 * 動作は種類ごとに実行者が違う。
 * - alert: オーバーレイが素材を再生する。照合はWorkerが行い（alert-event.ts の alertFor）、素材のURLを付けたアラートを返す
 * - chat: Workerがbotとしてチャットへ送る（オーバーレイには渡さない。オーバーレイに送信の役目を持たせないため）
 * - announce: Workerがbotとしてアナウンス（色の付いた帯）を送る。botがモデレーターにされている必要がある
 * - aiChat: Workerが配信者の指示とその人の記録からLLMに文面を作らせ、botとしてチャットへ送る（worker/ai-chat.ts）
 *
 * 対応しているイベントは8種類（ALERT_EVENTS）。うち7種類はWorkerが購読している通知で、チャットの発言は
 * botを接続しているときだけ通知が届く。広告の終了（AD_BREAK_END）だけはTwitchから届く通知ではなく、
 * 広告の開始の通知に入っている長さからWorkerが作る擬似イベントである（worker/ad-break-timer.ts）。
 * 条件は種類（kind）で判別する union のリストで、すべてを満たしたときだけトリガーが当てはまる（and）。
 * 条件を1件も持たないトリガーは、そのイベントが起きればいつでも当てはまる。
 * 同じ種類の条件は1トリガーに1件までにする（動作と同じ扱い。「報酬Aかつ報酬B」のような満たせない条件を作らせないため）。
 *
 * 条件の種類には、そのイベントにしか意味を持たないものがある（reward はチャンネルポイントの交換、text・firstChatOfStream・firstChatEver・returningAfter はチャットの発言）。
 * ほかのイベントに付いていたら黙って捨てずに保存を拒む（配信者が設定したつもりの絞り込みが効かないまま保存されるのを防ぐ）。
 *
 * 注意: 検証は最初の1件で止めず、問題点をすべて集めてから拒否する（管理画面で一度に直せるようにする）。
 * 注意: 条件をリストにする前の保存内容（event と rewardId が直接ぶら下がる形）は読み替えず、読み込みで失敗させる（Fail-Fast）。
 *   トリガーは数件なので、管理画面から入れ直してもらうほうが暗黙の読み替えを増やさずに済む。
 */
import type { KeyValueStore } from './store'
import { ANNOUNCEMENT_COLORS, type AnnouncementColor } from './twitch'

const CONFIG_KEY = 'alert-config'
const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
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

/** アラートを出せるイベントの種類 */
export const ALERT_EVENTS = [
  REDEMPTION,
  'channel.follow',
  'channel.subscribe',
  'channel.subscription.message',
  'channel.raid',
  CHAT_MESSAGE,
  AD_BREAK_BEGIN,
  AD_BREAK_END,
] as const

export type AlertEvent = (typeof ALERT_EVENTS)[number]

/** 条件の種類。同じ種類は1トリガーに1件まで */
export const CONDITION_KINDS = ['reward', 'user', 'text', 'firstChatOfStream', 'firstChatEver', 'returningAfter', 'automatic'] as const

export type ConditionKind = (typeof CONDITION_KINDS)[number]

/** 動作の種類。同じ種類は1トリガーに1件まで */
export const ACTION_TYPES = ['alert', 'chat', 'announce', 'aiChat'] as const

export type ActionType = (typeof ACTION_TYPES)[number]

const MAX_TRIGGERS = 100
const MIN_DURATION_SECONDS = 1
const MAX_DURATION_SECONDS = 60
const MAX_ALERT_MESSAGE_LENGTH = 200
/** チャット1通の上限（Twitchの POST /helix/chat/messages の制限）。アナウンスも同じ500文字で、text の条件の上限にも使う */
const MAX_CHAT_MESSAGE_LENGTH = 500
/** aiChat の指示（配信者が書く文章）の上限。文面そのものではなく作り方の指示なので、チャット1通より長くてよい */
const MAX_AI_INSTRUCTION_LENGTH = 1000
/** returningAfter に指定できる日数の下限（1日）。0日だと毎回当てはまり、条件なしと区別が付かない */
const MIN_RETURNING_DAYS = 1
/** returningAfter に指定できる日数の上限（1年）。これより長い間隔は「お久しぶり」として区別する意味が薄い */
const MAX_RETURNING_DAYS = 365
/** Twitchのユーザー名（login）の上限 */
const MAX_LOGIN_LENGTH = 25
/** 色を指定しなかったアナウンスの色（チャンネルの色） */
const DEFAULT_ANNOUNCEMENT_COLOR: AnnouncementColor = 'primary'

export type MediaKind = 'image' | 'video' | 'audio'

/** オーバーレイに素材を出す動作 */
export interface StoredAlertAction {
  type: 'alert'
  mediaId: string
  /** 素材の種類。保存時にサーバーが素材から調べて書き足す（オーバーレイへ渡すたびに素材を調べ直さないため） */
  mediaKind: MediaKind
  durationSeconds: number
  /** 音量（0〜1） */
  volume: number
  /** 表示する文言。イベント種別ごとの差し込み語（{user} など）が置き換わる。空文字なら文言を出さない */
  message: string
}

/** botとしてチャットへ送る動作 */
export interface StoredChatAction {
  type: 'chat'
  /** 送る文言。アラートと違い、送るものがないので空文字は許さない */
  message: string
}

/**
 * botとしてチャットへアナウンス（色の付いた帯で出る発言）を送る動作。
 *
 * 通常のチャット送信と違い、botがこのチャンネルのモデレーターにされていることと、
 * moderator:manage:announcements の認可が要る。
 */
export interface StoredAnnounceAction {
  type: 'announce'
  /** 送る文言。チャットと同じく、送るものがないので空文字は許さない */
  message: string
  /** 帯の色 */
  color: AnnouncementColor
}

/**
 * LLMに文面を作らせて、botとしてチャットへ送る動作。
 *
 * 固定文言の chat と違い、送る文言そのものではなく「どう書くか」の指示を持つ。
 * その人の記録（viewers のメモ・来訪の履歴）と発言の本文を材料に、Workerが実行のたびに文面を作る（worker/ai-chat.ts）。
 * 同じトリガーに chat と並べることは許さない（同じ発言に2通返ってしまうため。parseActions で拒む）。
 */
export interface StoredAiChatAction {
  type: 'aiChat'
  /** 配信者が書く、文面の作り方の指示。空文字では作りようがないので許さない */
  instruction: string
}

export type StoredAction = StoredAlertAction | StoredChatAction | StoredAnnounceAction | StoredAiChatAction

/**
 * 条件1件。種類（kind）で判別する union。
 *
 * - reward: 対象の報酬ID。チャンネルポイントの交換にしか付けられない。条件がなければすべての報酬が対象
 * - user: そのイベントの相手（交換した人・フォローした人・レイドした配信者・発言した人など）のTwitchのユーザー名（login）
 * - text: 発言の本文に含まれる文字。チャットの発言にしか付けられない（ほかのイベントは本文を持たない）
 * - firstChatOfStream: その配信で初めての発言であること。チャットの発言にしか付けられない。
 *   ほかの3種類と違って通知の中身だけでは決まらず、データベースに記録した「この配信で誰が発言したか」から決まる
 *   （判定は worker/chat-store.ts の claimFirstChatOfStream。照合に渡す値は worker/alert-state.ts が用意する）
 * - firstChatEver: このチャンネルで初めての発言であること。チャットの発言にしか付けられない。
 *   firstChatOfStream と違い、配信の区切りではなく視聴者の記録（viewers）から決まるので、常連は当てはまらない
 *   （判定は worker/viewer-store.ts の readChatHistory）
 * - returningAfter: 最後の発言から days 日以上空いていること。チャットの発言にしか付けられない。
 *   初めての発言では当てはまらない（空いた日数が決まらないため）
 * - automatic: 自動で入った広告か（true）、配信者が手動で打った広告か（false）。広告の開始・終了にしか付けられない。
 *   Twitchの通知の is_automatic をそのまま見る。手動で打った広告は配信者が自分で告知できるので、
 *   告知を自動広告だけに絞れるようにするための条件である
 */
export type StoredCondition =
  | { kind: 'reward'; rewardId: string }
  | { kind: 'user'; login: string }
  | { kind: 'text'; contains: string }
  | { kind: 'firstChatOfStream' }
  | { kind: 'firstChatEver' }
  | { kind: 'returningAfter'; days: number }
  | { kind: 'automatic'; automatic: boolean }

/** 保存するトリガー。条件はすべてを満たしたときだけ当てはまる（and） */
export type StoredTrigger = { event: AlertEvent; conditions: StoredCondition[]; actions: StoredAction[] }

export interface AlertConfig {
  triggers: StoredTrigger[]
}

export const EMPTY_CONFIG: AlertConfig = { triggers: [] }

/**
 * 設定の内容に問題がある。problems にすべての問題点を持つ。
 *
 * アラートの設定とチャットボットのコマンドの設定で使い回すため、何の設定かを subject で受け取る。
 */
export class ConfigError extends Error {
  override name = 'ConfigError'

  /** @param subject 何の設定か（例: アラートの設定） */
  constructor(
    readonly subject: string,
    readonly problems: readonly string[],
  ) {
    super(`${subject}に問題があります: ${problems.join(' / ')}`)
  }
}

/** このファイルが扱う設定の名前 */
const SUBJECT = 'アラートの設定'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isAlertEvent = (value: unknown): value is AlertEvent => ALERT_EVENTS.some((event) => event === value)

const isActionType = (value: unknown): value is ActionType => ACTION_TYPES.some((type) => type === value)

const isConditionKind = (value: unknown): value is ConditionKind => CONDITION_KINDS.some((kind) => kind === value)

const isAnnouncementColor = (value: unknown): value is AnnouncementColor => ANNOUNCEMENT_COLORS.some((color) => color === value)

const isNumberBetween = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

const isIntegerWithin = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

const isStringWithin = (value: unknown, min: number, max: number): value is string => typeof value === 'string' && value.length >= min && value.length <= max

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== ''

/**
 * 条件1件を検証して保存用の形にする。
 *
 * @param at 問題点に付ける位置（例: triggers[0].conditions[1]）
 * @param event このトリガーのイベント種別。イベント種別そのものが不正なときは null（reward を付けられるかの判定を飛ばす）
 * @param problems 見つけた問題点の記録先（最初の1件で止めず、すべて集めるため呼び出し側と共有する）
 * @returns 問題があれば null
 */
const parseCondition = (candidate: unknown, at: string, event: AlertEvent | null, problems: string[]): StoredCondition | null => {
  if (!isRecord(candidate)) {
    problems.push(`${at}: オブジェクトで指定してください`)
    return null
  }
  const { kind } = candidate
  if (!isConditionKind(kind)) {
    problems.push(`${at}.kind: ${CONDITION_KINDS.join(' / ')} のいずれかを指定してください`)
    return null
  }

  switch (kind) {
    case 'reward': {
      // 報酬IDはチャンネルポイントの交換にしか意味を持たないので、ほかのイベントに付いていたら拒否する
      // （黙って捨てると、配信者が設定したつもりの絞り込みが効かないまま保存される）
      if (event !== null && event !== REDEMPTION) {
        problems.push(`${at}: reward の条件はチャンネルポイントの交換にしか付けられません`)
        return null
      }
      const { rewardId } = candidate
      if (!isNonEmptyString(rewardId)) {
        problems.push(`${at}.rewardId: 報酬IDの文字列で指定してください`)
        return null
      }
      return { kind, rewardId }
    }
    case 'user': {
      const { login } = candidate
      if (!isStringWithin(login, 1, MAX_LOGIN_LENGTH)) {
        problems.push(`${at}.login: 1〜${MAX_LOGIN_LENGTH}文字のTwitchのユーザー名で指定してください`)
        return null
      }
      return { kind, login }
    }
    case 'text': {
      // 本文を持つのはチャットの発言だけなので、ほかのイベントに付いていたら拒否する（reward と同じ扱い）
      if (event !== null && event !== CHAT_MESSAGE) {
        problems.push(`${at}: text の条件はチャットの発言にしか付けられません`)
        return null
      }
      const { contains } = candidate
      // 空文字はすべての発言に当てはまってしまう（条件なしと区別が付かない）ので、1文字以上を求める
      if (!isStringWithin(contains, 1, MAX_CHAT_MESSAGE_LENGTH)) {
        problems.push(`${at}.contains: 1〜${MAX_CHAT_MESSAGE_LENGTH}文字の文字列で指定してください`)
        return null
      }
      return { kind, contains }
    }
    // 持つ項目がないので、種類が合っていて付けられるイベントであればそのまま通す
    case 'firstChatOfStream':
    case 'firstChatEver': {
      if (event !== null && event !== CHAT_MESSAGE) {
        problems.push(`${at}: ${kind} の条件はチャットの発言にしか付けられません`)
        return null
      }
      return { kind }
    }
    case 'returningAfter': {
      if (event !== null && event !== CHAT_MESSAGE) {
        problems.push(`${at}: returningAfter の条件はチャットの発言にしか付けられません`)
        return null
      }
      const { days } = candidate
      // 日数は整数で受け取る（画面の入力欄も日数なので、時間単位の細かさは持たせない）
      if (!isIntegerWithin(days, MIN_RETURNING_DAYS, MAX_RETURNING_DAYS)) {
        problems.push(`${at}.days: ${MIN_RETURNING_DAYS}〜${MAX_RETURNING_DAYS}の整数（日数）で指定してください`)
        return null
      }
      return { kind, days }
    }
    case 'automatic': {
      // 自動か手動かを持つのは広告の通知だけなので、ほかのイベントに付いていたら拒否する（reward と同じ扱い）
      if (event !== null && event !== AD_BREAK_BEGIN && event !== AD_BREAK_END) {
        problems.push(`${at}: automatic の条件は広告の開始・終了にしか付けられません`)
        return null
      }
      const { automatic } = candidate
      if (typeof automatic !== 'boolean') {
        problems.push(`${at}.automatic: true（自動で入った広告）か false（手動で打った広告）で指定してください`)
        return null
      }
      return { kind, automatic }
    }
  }
}

/**
 * 条件の一覧を検証して保存用の形にする。1件もなくてよいが、同じ種類が重複しないことを確かめる。
 *
 * 同じ種類を1件までにするのは、条件がすべて満たされたときだけ当てはまる（and）ため、
 * 同じ種類を2件並べると（報酬Aかつ報酬Bなど）決して当てはまらない設定を保存できてしまうのを防ぐため。
 *
 * @returns 問題があれば null
 */
const parseConditions = (candidate: unknown, at: string, event: AlertEvent | null, problems: string[]): StoredCondition[] | null => {
  if (!Array.isArray(candidate)) {
    problems.push(`${at}.conditions: 配列で指定してください`)
    return null
  }

  const conditions = candidate.flatMap((condition: unknown, index): StoredCondition[] => {
    const parsed = parseCondition(condition, `${at}.conditions[${index}]`, event, problems)
    return parsed === null ? [] : [parsed]
  })

  const duplicated = CONDITION_KINDS.filter((kind) => conditions.filter((condition) => condition.kind === kind).length > 1)
  for (const kind of duplicated) problems.push(`${at}.conditions: 同じ種類の条件（${kind}）は1件までにしてください`)

  return conditions.length === candidate.length && duplicated.length === 0 ? conditions : null
}

/**
 * 動作1件を検証して保存用の形にする。
 *
 * @param at 問題点に付ける位置（例: triggers[0].actions[1]）
 * @param problems 見つけた問題点の記録先（最初の1件で止めず、すべて集めるため呼び出し側と共有する）
 * @returns 問題があれば null
 */
const parseAction = (
  candidate: unknown,
  at: string,
  kindOfMedia: (mediaId: string) => MediaKind | null,
  problems: string[],
): StoredAction | null => {
  if (!isRecord(candidate)) {
    problems.push(`${at}: オブジェクトで指定してください`)
    return null
  }
  const { type } = candidate
  if (!isActionType(type)) {
    problems.push(`${at}.type: ${ACTION_TYPES.join(' / ')} のいずれかを指定してください`)
    return null
  }

  if (type === 'aiChat') {
    const { instruction } = candidate
    if (!isStringWithin(instruction, 1, MAX_AI_INSTRUCTION_LENGTH)) {
      problems.push(`${at}.instruction: 1〜${MAX_AI_INSTRUCTION_LENGTH}文字の文字列で指定してください`)
      return null
    }
    return { type, instruction }
  }

  if (type === 'chat' || type === 'announce') {
    const { message } = candidate
    const messageOk = isStringWithin(message, 1, MAX_CHAT_MESSAGE_LENGTH)
    if (!messageOk) problems.push(`${at}.message: 1〜${MAX_CHAT_MESSAGE_LENGTH}文字の文字列で指定してください`)
    if (type === 'chat') return messageOk ? { type, message } : null

    // 色は省略できる（既定はチャンネルの色）。指定があればTwitchが受け付ける5色に限る
    const { color } = candidate
    const colorOk = color === undefined || isAnnouncementColor(color)
    if (!colorOk) problems.push(`${at}.color: ${ANNOUNCEMENT_COLORS.join(' / ')} のいずれかを指定してください`)

    if (messageOk && colorOk) return { type, message, color: color ?? DEFAULT_ANNOUNCEMENT_COLOR }
    return null
  }

  const { mediaId, durationSeconds, volume, message } = candidate
  const mediaKind = typeof mediaId === 'string' ? kindOfMedia(mediaId) : null

  // 判定結果を変数に置くのは、問題点の記録と、下の if での型の絞り込みの両方に使うため
  const mediaOk = typeof mediaId === 'string' && mediaKind !== null
  const durationOk = isNumberBetween(durationSeconds, MIN_DURATION_SECONDS, MAX_DURATION_SECONDS)
  const volumeOk = isNumberBetween(volume, 0, 1)
  const messageOk = isStringWithin(message, 0, MAX_ALERT_MESSAGE_LENGTH)

  if (!mediaOk) problems.push(`${at}.mediaId: 素材「${String(mediaId)}」が存在しません`)
  if (!durationOk) problems.push(`${at}.durationSeconds: ${MIN_DURATION_SECONDS}〜${MAX_DURATION_SECONDS} の数値で指定してください`)
  if (!volumeOk) problems.push(`${at}.volume: 0〜1 の数値で指定してください`)
  if (!messageOk) problems.push(`${at}.message: ${MAX_ALERT_MESSAGE_LENGTH}文字以内の文字列で指定してください`)

  if (mediaOk && durationOk && volumeOk && messageOk) return { type, mediaId, mediaKind, durationSeconds, volume, message }
  return null
}

/**
 * 動作の一覧を検証して保存用の形にする。1件以上あり、同じ種類が重複しないことを確かめる。
 *
 * 同じ種類を1件までにするのは、オーバーレイへは「1トリガー = 1アラート」の平坦な形で渡すため
 * （オーバーレイは最初に一致したトリガーだけを再生するので、2件目は出ないまま設定だけが残ってしまう）。
 *
 * @returns 問題があれば null
 */
const parseActions = (candidate: unknown, at: string, kindOfMedia: (mediaId: string) => MediaKind | null, problems: string[]): StoredAction[] | null => {
  if (!Array.isArray(candidate) || candidate.length === 0) {
    problems.push(`${at}.actions: 1件以上の配列で指定してください`)
    return null
  }

  const actions = candidate.flatMap((action: unknown, index): StoredAction[] => {
    const parsed = parseAction(action, `${at}.actions[${index}]`, kindOfMedia, problems)
    return parsed === null ? [] : [parsed]
  })

  const duplicated = ACTION_TYPES.filter((type) => actions.filter((action) => action.type === type).length > 1)
  for (const type of duplicated) problems.push(`${at}.actions: 同じ種類の動作（${type}）は1件までにしてください`)

  // 固定文言（chat）とLLMの文面（aiChat）はどちらもbotの発言として送られるので、並べると同じ発言に2通返ってしまう
  const conflicting = actions.some((action) => action.type === 'chat') && actions.some((action) => action.type === 'aiChat')
  if (conflicting) problems.push(`${at}.actions: chat と aiChat は同じトリガーに並べられません（同じ発言に2通返ってしまうため）、どちらか一方にしてください`)

  return actions.length === candidate.length && duplicated.length === 0 && !conflicting ? actions : null
}

/**
 * 管理画面から送られてきた設定を検証し、保存用の形にする。
 *
 * @param kindOfMedia 素材IDから種類を引く。素材が存在しなければ null
 * @throws ConfigError 問題が1件でもある場合
 */
export const parseAlertConfig = (input: unknown, kindOfMedia: (mediaId: string) => MediaKind | null): AlertConfig => {
  if (!isRecord(input) || !Array.isArray(input.triggers)) throw new ConfigError(SUBJECT, ['triggers: 配列で指定してください'])
  if (input.triggers.length > MAX_TRIGGERS) throw new ConfigError(SUBJECT, [`triggers: ${MAX_TRIGGERS}件以内にしてください`])

  const problems: string[] = []
  const triggers = input.triggers.flatMap((candidate: unknown, index): StoredTrigger[] => {
    const at = `triggers[${index}]`
    if (!isRecord(candidate)) {
      problems.push(`${at}: オブジェクトで指定してください`)
      return []
    }
    const { event } = candidate

    // 判定結果を変数に置くのは、問題点の記録と、下の if での型の絞り込みの両方に使うため
    const eventOk = isAlertEvent(event)
    if (!eventOk) problems.push(`${at}.event: ${ALERT_EVENTS.join(' / ')} のいずれかを指定してください`)

    const conditions = parseConditions(candidate.conditions, at, eventOk ? event : null, problems)
    const actions = parseActions(candidate.actions, at, kindOfMedia, problems)

    if (eventOk && conditions !== null && actions !== null) return [{ event, conditions, actions }]
    return []
  })

  if (problems.length > 0) throw new ConfigError(SUBJECT, problems)
  return { triggers }
}

export const saveAlertConfig = (store: KeyValueStore, config: AlertConfig): Promise<void> => store.put(CONFIG_KEY, JSON.stringify(config))

/**
 * 保存されているトリガーが、いまの形（conditions と actions のリストを持つ）かどうか。
 *
 * 保存時に検証済みの内容しか書き込まないため、ここでは形だけを確かめる。
 * 条件をリストにする前の形（event と rewardId が直接ぶら下がる）や、動作に分ける前の形はここで弾かれる。
 */
const hasCurrentShape = (value: unknown): value is StoredTrigger => isRecord(value) && Array.isArray(value.conditions) && Array.isArray(value.actions)

/**
 * 読めなかったトリガーの問題点。何が保存されているのかを読み取れるよう、見つかった項目の名前を並べる。
 *
 * 復旧の手だても添える。管理画面（GET /api/admin/config）もこの読み出しを通るため、画面から直せない
 * （KVの設定を消せば、トリガーなしの状態から入れ直せる）。
 */
const unreadableProblem = (candidate: unknown, at: string): string => {
  const found = isRecord(candidate) ? Object.keys(candidate).join('・') : typeof candidate
  return `${at}: 保存されているトリガーが古い形です（見つかった項目: ${found}）。KVの ${CONFIG_KEY} を消してから入れ直してください`
}

/**
 * 保存済みの設定を読む。未保存ならトリガーなしの設定を返す。
 *
 * 注意: 古い形で保存されていたら、黙って読み替えずにエラーにする（Fail-Fast）。開発中で後方互換を保つ必要がないため、
 * 暗黙の読み替えを増やさず、KVの設定を消して入れ直す方針を採る。
 *
 * @throws ConfigError 保存されている内容がいまの形でない場合
 */
export const loadAlertConfig = async (store: KeyValueStore): Promise<AlertConfig> => {
  const text = await store.get(CONFIG_KEY)
  if (text === null) return EMPTY_CONFIG

  const config: unknown = JSON.parse(text)
  if (!isRecord(config) || !Array.isArray(config.triggers)) throw new ConfigError(SUBJECT, ['保存されている設定に triggers の配列がありません'])

  const triggers = config.triggers.map((candidate: unknown, index): StoredTrigger => {
    if (!hasCurrentShape(candidate)) throw new ConfigError(SUBJECT, [unreadableProblem(candidate, `triggers[${index}]`)])
    return candidate
  })
  return { triggers }
}

/** トリガーからチャットに送る動作を取り出す。なければ null */
export const chatActionOf = (trigger: StoredTrigger): StoredChatAction | null =>
  trigger.actions.find((action): action is StoredChatAction => action.type === 'chat') ?? null

/** トリガーからLLMに文面を作らせてチャットへ送る動作を取り出す。なければ null */
export const aiChatActionOf = (trigger: StoredTrigger): StoredAiChatAction | null =>
  trigger.actions.find((action): action is StoredAiChatAction => action.type === 'aiChat') ?? null

/** トリガーからアナウンスを送る動作を取り出す。なければ null */
export const announceActionOf = (trigger: StoredTrigger): StoredAnnounceAction | null =>
  trigger.actions.find((action): action is StoredAnnounceAction => action.type === 'announce') ?? null

/** トリガーからアラートを出す動作を取り出す。なければ null */
export const alertActionOf = (trigger: StoredTrigger): StoredAlertAction | null =>
  trigger.actions.find((action): action is StoredAlertAction => action.type === 'alert') ?? null

/** 素材をオーバーレイから読むためのパス。キーが違えばWorkerが拒否する */
export const mediaPath = (mediaId: string, overlayKey: string): string =>
  `/api/media/${encodeURIComponent(mediaId)}?key=${encodeURIComponent(overlayKey)}`
