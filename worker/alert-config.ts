/**
 * アラートの設定
 *
 * 「どのイベントで、どの素材を、どう出すか」（トリガー）の一覧を、管理画面から受け取って検証し、ストア（KV）に保存する。
 * オーバーレイへ渡すときは、素材IDをオーバーレイ用キー付きの素材のURLへ置き換える（toOverlayConfig）。
 * いま対応しているイベントはチャンネルポイントの交換だけ。
 *
 * 注意: 検証は最初の1件で止めず、問題点をすべて集めてから拒否する（管理画面で一度に直せるようにする）。
 */
import type { KeyValueStore } from './store'

const CONFIG_KEY = 'alert-config'
const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
const MAX_TRIGGERS = 100
const MIN_DURATION_SECONDS = 1
const MAX_DURATION_SECONDS = 60
const MAX_MESSAGE_LENGTH = 200

export type MediaKind = 'image' | 'video' | 'audio'

/** 保存するトリガー */
export interface StoredTrigger {
  event: typeof REDEMPTION
  /** 対象の報酬ID。null はすべての報酬 */
  rewardId: string | null
  mediaId: string
  /** 素材の種類。保存時にサーバーが素材から調べて書き足す（オーバーレイへ渡すたびに素材を調べ直さないため） */
  mediaKind: MediaKind
  durationSeconds: number
  /** 音量（0〜1） */
  volume: number
  /** 表示する文言。{user} と {reward} が置き換わる。空文字なら文言を出さない */
  message: string
}

export interface AlertConfig {
  triggers: StoredTrigger[]
}

export const EMPTY_CONFIG: AlertConfig = { triggers: [] }

/** 設定の内容に問題がある。problems にすべての問題点を持つ */
export class ConfigError extends Error {
  override name = 'ConfigError'

  constructor(readonly problems: readonly string[]) {
    super(`アラートの設定に問題があります: ${problems.join(' / ')}`)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isNumberBetween = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

/**
 * 管理画面から送られてきた設定を検証し、保存用の形にする。
 *
 * @param kindOfMedia 素材IDから種類を引く。素材が存在しなければ null
 * @throws ConfigError 問題が1件でもある場合
 */
export const parseAlertConfig = (input: unknown, kindOfMedia: (mediaId: string) => MediaKind | null): AlertConfig => {
  if (!isRecord(input) || !Array.isArray(input.triggers)) throw new ConfigError(['triggers: 配列で指定してください'])
  if (input.triggers.length > MAX_TRIGGERS) throw new ConfigError([`triggers: ${MAX_TRIGGERS}件以内にしてください`])

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
    const eventOk = event === REDEMPTION
    const rewardOk = rewardId === null || (typeof rewardId === 'string' && rewardId !== '')
    const mediaOk = typeof mediaId === 'string' && mediaKind !== null
    const durationOk = isNumberBetween(durationSeconds, MIN_DURATION_SECONDS, MAX_DURATION_SECONDS)
    const volumeOk = isNumberBetween(volume, 0, 1)
    const messageOk = typeof message === 'string' && message.length <= MAX_MESSAGE_LENGTH

    if (!eventOk) problems.push(`${at}.event: ${REDEMPTION} を指定してください`)
    if (!rewardOk) problems.push(`${at}.rewardId: 報酬IDの文字列か、すべての報酬を表す null を指定してください`)
    if (!mediaOk) problems.push(`${at}.mediaId: 素材「${String(mediaId)}」が存在しません`)
    if (!durationOk) problems.push(`${at}.durationSeconds: ${MIN_DURATION_SECONDS}〜${MAX_DURATION_SECONDS} の数値で指定してください`)
    if (!volumeOk) problems.push(`${at}.volume: 0〜1 の数値で指定してください`)
    if (!messageOk) problems.push(`${at}.message: ${MAX_MESSAGE_LENGTH}文字以内の文字列で指定してください`)

    if (eventOk && rewardOk && mediaOk && durationOk && volumeOk && messageOk) {
      return [{ event, rewardId, mediaId, mediaKind, durationSeconds, volume, message }]
    }
    return []
  })

  if (problems.length > 0) throw new ConfigError(problems)
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

/** オーバーレイ（src/alerts/trigger.ts の AlertTrigger）が受け取る形へ変換する */
export const toOverlayConfig = (config: AlertConfig, overlayKey: string) => ({
  triggers: config.triggers.map(({ event, rewardId, mediaId, mediaKind, durationSeconds, volume, message }) => ({
    event,
    rewardId,
    media: { kind: mediaKind, url: mediaPath(mediaId, overlayKey) },
    durationSeconds,
    volume,
    message,
  })),
})
