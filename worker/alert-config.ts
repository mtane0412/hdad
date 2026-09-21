/**
 * アラートの設定
 *
 * 「どのイベントで、どの素材を、どう出すか」（トリガー）の一覧を、管理画面から受け取って検証し、ストア（KV）に保存する。
 * オーバーレイへ渡すときは、素材IDをオーバーレイ用キー付きの素材のURLへ置き換える（toOverlayConfig）。
 * 対応しているイベントは、Workerが購読している5種類（ALERT_EVENTS）。
 * 条件（いまは報酬IDだけ）はイベント種別ごとに違うため、event で判別する union にする。
 *
 * 注意: 検証は最初の1件で止めず、問題点をすべて集めてから拒否する（管理画面で一度に直せるようにする）。
 */
import type { KeyValueStore } from './store'

const CONFIG_KEY = 'alert-config'
const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'

/** アラートを出せるイベントの種類。src/alerts/trigger.ts の ALERT_EVENTS と同じ並び（worker/ と src/ は互いに読み込まない約束） */
export const ALERT_EVENTS = [REDEMPTION, 'channel.follow', 'channel.subscribe', 'channel.subscription.message', 'channel.raid'] as const

export type AlertEvent = (typeof ALERT_EVENTS)[number]

const MAX_TRIGGERS = 100
const MIN_DURATION_SECONDS = 1
const MAX_DURATION_SECONDS = 60
const MAX_MESSAGE_LENGTH = 200

export type MediaKind = 'image' | 'video' | 'audio'

/** 出し方（イベント種別によらず共通） */
interface StoredAppearance {
  mediaId: string
  /** 素材の種類。保存時にサーバーが素材から調べて書き足す（オーバーレイへ渡すたびに素材を調べ直さないため） */
  mediaKind: MediaKind
  durationSeconds: number
  /** 音量（0〜1） */
  volume: number
  /** 表示する文言。イベント種別ごとの差し込み語（{user} など）が置き換わる。空文字なら文言を出さない */
  message: string
}

/** 条件（イベント種別ごとに違う。いま条件を持つのはチャンネルポイント交換だけ） */
type StoredCondition =
  /** 対象の報酬ID。null はすべての報酬 */
  | { event: typeof REDEMPTION; rewardId: string | null }
  | { event: Exclude<AlertEvent, typeof REDEMPTION> }

/** 保存するトリガー */
export type StoredTrigger = StoredAppearance & StoredCondition

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

const isNumberBetween = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

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
    const { event, rewardId, mediaId, durationSeconds, volume, message } = candidate
    const mediaKind = typeof mediaId === 'string' ? kindOfMedia(mediaId) : null

    // 判定結果を変数に置くのは、問題点の記録と、下の if での型の絞り込みの両方に使うため
    const eventOk = isAlertEvent(event)
    // 報酬IDとして読める値（読めなければ undefined）。問題点の記録と、下の if での型の絞り込みの両方に使う
    const reward = rewardId === null || (typeof rewardId === 'string' && rewardId !== '') ? rewardId : undefined
    // 報酬IDはチャンネルポイント交換にしか意味を持たないので、そのときだけ確かめる
    const rewardOk = event !== REDEMPTION || reward !== undefined
    const mediaOk = typeof mediaId === 'string' && mediaKind !== null
    const durationOk = isNumberBetween(durationSeconds, MIN_DURATION_SECONDS, MAX_DURATION_SECONDS)
    const volumeOk = isNumberBetween(volume, 0, 1)
    const messageOk = typeof message === 'string' && message.length <= MAX_MESSAGE_LENGTH

    if (!eventOk) problems.push(`${at}.event: ${ALERT_EVENTS.join(' / ')} のいずれかを指定してください`)
    if (!rewardOk) problems.push(`${at}.rewardId: 報酬IDの文字列か、すべての報酬を表す null を指定してください`)
    if (!mediaOk) problems.push(`${at}.mediaId: 素材「${String(mediaId)}」が存在しません`)
    if (!durationOk) problems.push(`${at}.durationSeconds: ${MIN_DURATION_SECONDS}〜${MAX_DURATION_SECONDS} の数値で指定してください`)
    if (!volumeOk) problems.push(`${at}.volume: 0〜1 の数値で指定してください`)
    if (!messageOk) problems.push(`${at}.message: ${MAX_MESSAGE_LENGTH}文字以内の文字列で指定してください`)

    if (eventOk && rewardOk && mediaOk && durationOk && volumeOk && messageOk) {
      const appearance = { mediaId, mediaKind, durationSeconds, volume, message }
      // 報酬IDは、他のイベントへ引きずらないようチャンネルポイント交換のときだけ保存する
      if (event === REDEMPTION) return reward === undefined ? [] : [{ event, rewardId: reward, ...appearance }]
      return [{ event, ...appearance }]
    }
    return []
  })

  if (problems.length > 0) throw new ConfigError(SUBJECT, problems)
  return { triggers }
}

export const saveAlertConfig = (store: KeyValueStore, config: AlertConfig): Promise<void> => store.put(CONFIG_KEY, JSON.stringify(config))

/**
 * 保存済みの設定を読む。未保存ならトリガーなしの設定を返す。
 *
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない。
 */
export const loadAlertConfig = async (store: KeyValueStore): Promise<AlertConfig> => {
  const text = await store.get(CONFIG_KEY)
  return text === null ? EMPTY_CONFIG : (JSON.parse(text) as AlertConfig)
}

/** 素材をオーバーレイから読むためのパス。キーが違えばWorkerが拒否する */
export const mediaPath = (mediaId: string, overlayKey: string): string =>
  `/api/media/${encodeURIComponent(mediaId)}?key=${encodeURIComponent(overlayKey)}`

/** オーバーレイ（src/alerts/trigger.ts の AlertTrigger）が受け取る形へ変換する。条件の欄はイベント種別ごとに通す */
export const toOverlayConfig = (config: AlertConfig, overlayKey: string) => ({
  triggers: config.triggers.map((trigger) => {
    const { mediaId, mediaKind, durationSeconds, volume, message } = trigger
    const appearance = { media: { kind: mediaKind, url: mediaPath(mediaId, overlayKey) }, durationSeconds, volume, message }
    if (trigger.event === REDEMPTION) return { event: trigger.event, rewardId: trigger.rewardId, ...appearance }
    return { event: trigger.event, ...appearance }
  }),
})
