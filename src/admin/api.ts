/**
 * 管理用APIの呼び出し
 *
 * 管理画面はWorker（/api/me・/api/admin/*）を同じサイトの相対パスで呼び出す。
 * セッションのクッキーと、書き換えを伴うメソッドの Origin ヘッダーはブラウザが付けるので、ここでは何もしない。
 * worker/ のコードはブラウザ用のコードから読み込まない約束なので、応答の型はここで定義し、受け取るたびに形を確かめる。
 * 呼び出しと失敗の扱いは `@/core/api` に任せる。fetch を引数で受け取るのは、テストで差し替えるため。
 *
 * 注意: 応答が想定した形でなければエラーにする。黙って空の一覧にすると、設定や素材が消えたように見えてしまう。
 */
import { ApiError, createCaller, isRecord, readList } from '@/core/api'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
const CHAT_MESSAGE = 'channel.chat.message'
const AD_BREAK_BEGIN = 'channel.ad_break.begin'
/** 広告の終了。Twitchから届く通知ではなく、Workerが広告の長さから作る擬似イベント（worker/ad-break-timer.ts） */
const AD_BREAK_END = 'channel.ad_break.end'

/** アラートを出せるイベントの種類。worker/alert-config.ts の ALERT_EVENTS と同じ並び（worker/ の型は読み込めないのでここで定義する） */
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

const MEDIA_KINDS = ['image', 'video', 'audio'] as const
const UNAUTHORIZED = 401

export type MediaKind = (typeof MEDIA_KINDS)[number]

/** ログイン中の配信者。overlayKey は未発行なら null */
export interface Me {
  userId: string
  login: string
  overlayKey: string | null
}

/** R2に置いた素材 */
export interface MediaItem {
  id: string
  name: string
  kind: MediaKind
  contentType: string
  /** 大きさ（バイト） */
  size: number
  /** アップロードした時刻（ISO 8601） */
  uploadedAt: string
}

/** オーバーレイに素材を出す動作。素材の種類（mediaKind）はWorkerが決めるので送らない */
interface AlertActionInput {
  type: 'alert'
  mediaId: string
  durationSeconds: number
  /** 0〜1 */
  volume: number
  message: string
}

/** botとしてチャットへ送る動作。実行するのはWorkerで、オーバーレイには渡らない */
export interface ChatAction {
  type: 'chat'
  message: string
}

/** アナウンスの帯の色。Twitchが受け付けるのはこの5つで、primary はチャンネルの色 */
export const ANNOUNCEMENT_COLORS = ['primary', 'blue', 'green', 'orange', 'purple'] as const

export type AnnouncementColor = (typeof ANNOUNCEMENT_COLORS)[number]

/** botとしてアナウンス（色の付いた帯）を送る動作。botがモデレーターにされている必要がある */
export interface AnnounceAction {
  type: 'announce'
  message: string
  color: AnnouncementColor
}

/**
 * LLMに文面を作らせて、botとしてチャットへ送る動作。
 *
 * 固定文言の chat と違い、送る文言ではなく「どう書くか」の指示を持つ。同じトリガーに chat とは並べられない
 * （同じ発言に2通返ってしまうため、Workerが保存を拒否する）。
 */
export interface AiChatAction {
  type: 'aiChat'
  instruction: string
}

export type ActionInput = AlertActionInput | ChatAction | AnnounceAction | AiChatAction

/**
 * 既定メニューの項目。worker/trigger-menu.ts の TRIGGER_KINDS と同じ並び（worker/ の型は読み込めないのでここで定義する）。
 *
 * 配信者はイベント種別と条件を自由に組み合わせず、この一覧に効果を足していく。
 * どのイベントを対象にするか（差し込み語がどれになるか）は kind から決まる（src/admin/form.ts の EVENT_OF_KIND）。
 */
export const TRIGGER_KINDS = [
  'newViewer',
  'comeback',
  'welcome',
  'everyMessage',
  'keyword',
  'fromUser',
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
 * null を取るパラメータは「絞り込まない」を表す（rewardId ならすべての報酬、automatic なら自動・手動のどちらでも）。
 */
export type TriggerSource =
  | { kind: 'newViewer' | 'welcome' | 'everyMessage' }
  | { kind: 'comeback'; days: number }
  | { kind: 'fromUser'; login: string }
  | { kind: 'keyword'; contains: string }
  | { kind: 'reward'; rewardId: string | null }
  | { kind: 'follow' | 'subscribe' | 'resubscribe' | 'raid' }
  | { kind: 'adBreakBegin' | 'adBreakEnd'; automatic: boolean | null }

/** 保存するトリガー。既定メニューの項目と、そのとき行う動作の一覧からなる */
export type TriggerInput = TriggerSource & { actions: ActionInput[] }

/** 保存済みの「アラートを出す」動作（Workerが素材の種類を書き足したもの） */
export type StoredAlertAction = AlertActionInput & { mediaKind: MediaKind }

export type StoredAction = StoredAlertAction | ChatAction | AnnounceAction | AiChatAction

/** 保存済みのトリガー */
export type StoredTrigger = TriggerSource & { actions: StoredAction[] }

/** チャンネルポイント報酬 */
export interface Reward {
  id: string
  title: string
  cost: number
}

export interface AdminApi {
  /** ログイン中の配信者。未ログインなら null */
  me(): Promise<Me | null>
  config(): Promise<StoredTrigger[]>
  /** トリガーの一覧をまるごと置き換えて保存する */
  saveConfig(triggers: readonly TriggerInput[]): Promise<StoredTrigger[]>
  media(): Promise<MediaItem[]>
  upload(file: File): Promise<MediaItem>
  removeMedia(id: string): Promise<void>
  /** オーバーレイ用キーを発行し直す。古いキーを含むURLは使えなくなる */
  rotateOverlayKey(): Promise<string>
  rewards(): Promise<Reward[]>
  logout(): Promise<void>
}

const isMediaKind = (value: unknown): value is MediaKind => MEDIA_KINDS.some((kind) => kind === value)

/** アナウンスの色として使える値か。選択欄の値を色として扱う前の確認にも使う */
export const isAnnouncementColor = (value: unknown): value is AnnouncementColor => ANNOUNCEMENT_COLORS.some((color) => color === value)

const isMe = (value: unknown): value is Me =>
  isRecord(value) && typeof value.userId === 'string' && typeof value.login === 'string' && (value.overlayKey === null || typeof value.overlayKey === 'string')

const isMediaItem = (value: unknown): value is MediaItem =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.name === 'string' &&
  isMediaKind(value.kind) &&
  typeof value.contentType === 'string' &&
  typeof value.size === 'number' &&
  typeof value.uploadedAt === 'string'

/**
 * トリガーのきっかけの形。メニュー項目ごとに持つパラメータが違う。
 *
 * 知らないメニュー項目は受け取らない（黙って無視すると、絞り込みが効かないまま画面に出てしまう）。
 */
const isTriggerSource = (value: unknown): value is TriggerSource => {
  if (!isRecord(value)) return false
  if (value.kind === 'comeback') return typeof value.days === 'number'
  if (value.kind === 'fromUser') return typeof value.login === 'string'
  if (value.kind === 'keyword') return typeof value.contains === 'string'
  // null は「すべての報酬」を表す
  if (value.kind === 'reward') return value.rewardId === null || typeof value.rewardId === 'string'
  // null は「自動・手動のどちらでも」を表す
  if (value.kind === 'adBreakBegin' || value.kind === 'adBreakEnd') return value.automatic === null || typeof value.automatic === 'boolean'
  // パラメータを持たないメニュー項目なので、名前が合っていればそれでよい
  return TRIGGER_KINDS.some((kind) => kind === value.kind)
}

/** 保存済みの動作1件の形。種類ごとに持つ項目が違う */
const isStoredAction = (value: unknown): value is StoredAction => {
  if (!isRecord(value)) return false
  // aiChat だけは送る文言を持たず、文面の作り方の指示を持つ
  if (value.type === 'aiChat') return typeof value.instruction === 'string'
  if (typeof value.message !== 'string') return false
  if (value.type === 'chat') return true
  if (value.type === 'announce') return isAnnouncementColor(value.color)
  return (
    value.type === 'alert' &&
    typeof value.mediaId === 'string' &&
    isMediaKind(value.mediaKind) &&
    typeof value.durationSeconds === 'number' &&
    typeof value.volume === 'number'
  )
}

// 動作の確認を先に置くのは、きっかけの確認で TriggerSource に狭まると actions を読めなくなるためである
const isStoredTrigger = (value: unknown): value is StoredTrigger =>
  isRecord(value) && Array.isArray(value.actions) && value.actions.every(isStoredAction) && isTriggerSource(value)

const isReward = (value: unknown): value is Reward =>
  isRecord(value) && typeof value.id === 'string' && typeof value.title === 'string' && typeof value.cost === 'number'

export const createAdminApi = (fetchImpl: typeof fetch): AdminApi => {
  const call = createCaller(fetchImpl)

  return {
    me: async () => {
      const body = await call('/api/me').catch((error: unknown) => {
        // 未ログインは管理画面にとって普通の状態（ログインの案内を出す）なので、失敗として扱わない
        if (error instanceof ApiError && error.status === UNAUTHORIZED) return null
        throw error
      })
      if (body === null) return null
      if (!isMe(body)) throw new Error('Workerの /api/me の応答が想定した形ではありません')
      return body
    },

    config: async () => readList(await call('/api/admin/config'), 'triggers', isStoredTrigger),

    saveConfig: async (triggers) => {
      const body = await call('/api/admin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ triggers }),
      })
      return readList(body, 'triggers', isStoredTrigger)
    },

    media: async () => readList(await call('/api/admin/media'), 'media', isMediaItem),

    upload: async (file) => {
      const body = await call('/api/admin/media', {
        method: 'POST',
        // ヘッダーには日本語をそのまま入れられないので、ファイル名はURLエンコードする（Worker側で戻す）
        headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) },
        body: file,
      })
      if (!isMediaItem(body)) throw new Error('Workerのアップロードの応答が想定した形ではありません')
      return body
    },

    removeMedia: async (id) => {
      await call(`/api/admin/media/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },

    rotateOverlayKey: async () => {
      const body = await call('/api/admin/overlay-key', { method: 'POST' })
      if (!isRecord(body) || typeof body.overlayKey !== 'string') throw new Error('Workerの応答に overlayKey がありません')
      return body.overlayKey
    },

    rewards: async () => readList(await call('/api/admin/rewards'), 'rewards', isReward),

    logout: async () => {
      await call('/api/auth/logout', { method: 'POST' })
    },
  }
}
