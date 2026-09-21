/**
 * アラートの設定
 *
 * 「どのイベントで、何をするか」（トリガー）の一覧を、管理画面から受け取って検証し、ストア（KV）に保存する。
 * トリガーは「条件」（どのイベントか。いまは報酬IDだけが条件を持つ）と「動作」（actions）に分かれる。
 * 動作は種類ごとに実行者が違う。
 * - alert: オーバーレイが素材を再生する。toOverlayConfig で素材のURLを付けた平坦な形へ展開して渡す
 * - chat: Workerがbotとしてチャットへ送る（オーバーレイには渡さない。オーバーレイに送信の役目を持たせないため）
 * - announce: Workerがbotとしてアナウンス（色の付いた帯）を送る。botがモデレーターにされている必要がある
 *
 * 対応しているイベントは、Workerが購読している5種類（ALERT_EVENTS）。
 * 条件（いまは報酬IDだけ）はイベント種別ごとに違うため、event で判別する union にする。
 *
 * 注意: 検証は最初の1件で止めず、問題点をすべて集めてから拒否する（管理画面で一度に直せるようにする）。
 */
import type { KeyValueStore } from './store'
import { ANNOUNCEMENT_COLORS, type AnnouncementColor } from './twitch'

const CONFIG_KEY = 'alert-config'
const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'

/** アラートを出せるイベントの種類。src/alerts/trigger.ts の ALERT_EVENTS と同じ並び（worker/ と src/ は互いに読み込まない約束） */
export const ALERT_EVENTS = [REDEMPTION, 'channel.follow', 'channel.subscribe', 'channel.subscription.message', 'channel.raid'] as const

export type AlertEvent = (typeof ALERT_EVENTS)[number]

/** 動作の種類。同じ種類は1トリガーに1件まで */
export const ACTION_TYPES = ['alert', 'chat', 'announce'] as const

export type ActionType = (typeof ACTION_TYPES)[number]

const MAX_TRIGGERS = 100
const MIN_DURATION_SECONDS = 1
const MAX_DURATION_SECONDS = 60
const MAX_ALERT_MESSAGE_LENGTH = 200
/** チャット1通の上限（Twitchの POST /helix/chat/messages の制限）。アナウンスも同じ500文字 */
const MAX_CHAT_MESSAGE_LENGTH = 500
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

export type StoredAction = StoredAlertAction | StoredChatAction | StoredAnnounceAction

/** 条件（イベント種別ごとに違う。いま条件を持つのはチャンネルポイント交換だけ） */
type StoredCondition =
  /** 対象の報酬ID。null はすべての報酬 */
  | { event: typeof REDEMPTION; rewardId: string | null }
  | { event: Exclude<AlertEvent, typeof REDEMPTION> }

/** 保存するトリガー */
export type StoredTrigger = StoredCondition & { actions: StoredAction[] }

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

const isAnnouncementColor = (value: unknown): value is AnnouncementColor => ANNOUNCEMENT_COLORS.some((color) => color === value)

const isNumberBetween = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

const isStringWithin = (value: unknown, min: number, max: number): value is string => typeof value === 'string' && value.length >= min && value.length <= max

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

  return actions.length === candidate.length && duplicated.length === 0 ? actions : null
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
    const { event, rewardId } = candidate

    // 判定結果を変数に置くのは、問題点の記録と、下の if での型の絞り込みの両方に使うため
    const eventOk = isAlertEvent(event)
    // 報酬IDとして読める値（読めなければ undefined）。問題点の記録と、下の if での型の絞り込みの両方に使う
    const reward = rewardId === null || (typeof rewardId === 'string' && rewardId !== '') ? rewardId : undefined
    // 報酬IDはチャンネルポイント交換にしか意味を持たないので、そのときだけ確かめる
    const rewardOk = event !== REDEMPTION || reward !== undefined

    if (!eventOk) problems.push(`${at}.event: ${ALERT_EVENTS.join(' / ')} のいずれかを指定してください`)
    if (!rewardOk) problems.push(`${at}.rewardId: 報酬IDの文字列か、すべての報酬を表す null を指定してください`)

    const actions = parseActions(candidate.actions, at, kindOfMedia, problems)

    if (eventOk && rewardOk && actions !== null) {
      // 報酬IDは、他のイベントへ引きずらないようチャンネルポイント交換のときだけ保存する
      if (event === REDEMPTION) return reward === undefined ? [] : [{ event, rewardId: reward, actions }]
      return [{ event, actions }]
    }
    return []
  })

  if (problems.length > 0) throw new ConfigError(SUBJECT, problems)
  return { triggers }
}

export const saveAlertConfig = (store: KeyValueStore, config: AlertConfig): Promise<void> => store.put(CONFIG_KEY, JSON.stringify(config))

/**
 * 動作に分ける前の形で保存されているトリガーを、いまの形へ読み替える。
 *
 * 動作（actions）を入れる前は、出し方（mediaId など）がトリガーに直接ぶら下がっていた。保存済みの設定を失わないための読み替えで、
 * 管理画面から一度保存すればいまの形で書き戻る。旧形式でも新形式でもない内容は、黙って捨てずにエラーにする（Fail-Fast）。
 *
 * 注意: この読み替えは、保存済みの設定がすべていまの形に入れ替わったら外してよい。
 */
const migrateTrigger = (trigger: Record<string, unknown>): StoredTrigger => {
  if (Array.isArray(trigger.actions)) return trigger as unknown as StoredTrigger

  const { event, rewardId, mediaId, mediaKind, durationSeconds, volume, message } = trigger
  if (typeof mediaId !== 'string' || typeof mediaKind !== 'string' || typeof durationSeconds !== 'number' || typeof volume !== 'number' || typeof message !== 'string') {
    throw new ConfigError(SUBJECT, [`保存されているトリガー（${String(event)}）を読めません`])
  }

  const action: StoredAlertAction = { type: 'alert', mediaId, mediaKind: mediaKind as MediaKind, durationSeconds, volume, message }
  if (event === REDEMPTION) return { event, rewardId: typeof rewardId === 'string' ? rewardId : null, actions: [action] }
  return { event: event as Exclude<AlertEvent, typeof REDEMPTION>, actions: [action] }
}

/**
 * 保存済みの設定を読む。未保存ならトリガーなしの設定を返す。
 *
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない。
 * 動作に分ける前の形だけは、いまの形へ読み替える（migrateTrigger）。
 */
export const loadAlertConfig = async (store: KeyValueStore): Promise<AlertConfig> => {
  const text = await store.get(CONFIG_KEY)
  if (text === null) return EMPTY_CONFIG

  const config = JSON.parse(text) as { triggers: Record<string, unknown>[] }
  return { triggers: config.triggers.map(migrateTrigger) }
}

/** トリガーからチャットに送る動作を取り出す。なければ null */
export const chatActionOf = (trigger: StoredTrigger): StoredChatAction | null =>
  trigger.actions.find((action): action is StoredChatAction => action.type === 'chat') ?? null

/** トリガーからアナウンスを送る動作を取り出す。なければ null */
export const announceActionOf = (trigger: StoredTrigger): StoredAnnounceAction | null =>
  trigger.actions.find((action): action is StoredAnnounceAction => action.type === 'announce') ?? null

/** トリガーからアラートを出す動作を取り出す。なければ null */
export const alertActionOf = (trigger: StoredTrigger): StoredAlertAction | null =>
  trigger.actions.find((action): action is StoredAlertAction => action.type === 'alert') ?? null

/** オーバーレイが受け取るトリガー1件（条件と出し方が平坦に並ぶ。src/alerts/trigger.ts の AlertTrigger に対応する） */
type OverlayTrigger = {
  media: { kind: MediaKind; url: string }
  durationSeconds: number
  volume: number
  message: string
} & ({ event: typeof REDEMPTION; rewardId: string | null } | { event: Exclude<AlertEvent, typeof REDEMPTION> })

/** 素材をオーバーレイから読むためのパス。キーが違えばWorkerが拒否する */
export const mediaPath = (mediaId: string, overlayKey: string): string =>
  `/api/media/${encodeURIComponent(mediaId)}?key=${encodeURIComponent(overlayKey)}`

/**
 * オーバーレイ（src/alerts/trigger.ts の AlertTrigger）が受け取る形へ変換する。
 *
 * オーバーレイは「条件 + 出し方」の平坦なトリガーしか知らないので、アラートを出す動作をここで展開する。
 * チャットに送る動作は渡さない（送るのはWorkerの役目で、オーバーレイに送信の権限を持たせないため）。
 * アラートを出す動作を持たないトリガー（チャットに送るだけ）は一覧から落とす。
 */
export const toOverlayConfig = (config: AlertConfig, overlayKey: string) => ({
  triggers: config.triggers.flatMap((trigger): OverlayTrigger[] => {
    const action = alertActionOf(trigger)
    if (action === null) return []

    const { mediaId, mediaKind, durationSeconds, volume, message } = action
    const appearance = { media: { kind: mediaKind, url: mediaPath(mediaId, overlayKey) }, durationSeconds, volume, message }
    if (trigger.event === REDEMPTION) return [{ event: trigger.event, rewardId: trigger.rewardId, ...appearance }]
    return [{ event: trigger.event, ...appearance }]
  }),
})
