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

/** 保存するトリガー。素材の種類（mediaKind）はWorkerが決めるので送らない */
export interface TriggerInput {
  event: typeof REDEMPTION
  /** null はすべての報酬 */
  rewardId: string | null
  mediaId: string
  durationSeconds: number
  /** 0〜1 */
  volume: number
  message: string
}

/** 保存済みのトリガー */
export interface StoredTrigger extends TriggerInput {
  mediaKind: MediaKind
}

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

const isStoredTrigger = (value: unknown): value is StoredTrigger =>
  isRecord(value) &&
  value.event === REDEMPTION &&
  (value.rewardId === null || typeof value.rewardId === 'string') &&
  typeof value.mediaId === 'string' &&
  isMediaKind(value.mediaKind) &&
  typeof value.durationSeconds === 'number' &&
  typeof value.volume === 'number' &&
  typeof value.message === 'string'

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
