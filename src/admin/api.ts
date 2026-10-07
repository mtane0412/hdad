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
import { readTownTourNarration, type TownTourNarration } from '@/town-tour/narration'
import { readTownTourSound, type TownTourSound } from '@/town-tour/sound'
import { readTwisterSound, type TwisterSound } from '@/twister/sound'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
const CHAT_MESSAGE = 'channel.chat.message'
const AD_BREAK_BEGIN = 'channel.ad_break.begin'
/** 広告の終了。Twitchから届く通知ではなく、Workerが広告の長さから作る擬似イベント（worker/ad-break-timer.ts） */
const AD_BREAK_END = 'channel.ad_break.end'
/** コミットの push・PR のマージ。Twitchではなく GitHub の Webhook から届く出来事（worker/github-routes.ts） */
const GITHUB_PUSH = 'github.push'
const GITHUB_PULL_REQUEST_MERGED = 'github.pull_request.merged'
/** ポモドーロの作業の開始・休憩の開始。Workerのタイマーが作る擬似イベント（worker/pomodoro-timer.ts） */
const POMODORO_WORK_BEGIN = 'hdad.pomodoro.work_begin'
const POMODORO_BREAK_BEGIN = 'hdad.pomodoro.break_begin'

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
  GITHUB_PUSH,
  GITHUB_PULL_REQUEST_MERGED,
  POMODORO_WORK_BEGIN,
  POMODORO_BREAK_BEGIN,
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

/**
 * botとしてシャウトアウト（相手の配信者を紹介するTwitch組み込みの機能）を送る動作。
 *
 * 紹介する相手はイベントの中身から決まるので、配信者が決める項目を持たない。
 * 置けるのはレイドの項目だけで（src/admin/form.ts の supportsShoutout）、botがモデレーターにされている必要がある。
 */
export interface ShoutoutAction {
  type: 'shoutout'
}

/**
 * 市町村を1つ引いて、合成ページの素材「市町村紹介」に流させる動作（issue #229）。
 *
 * 引く市町村はその都度ランダムなので、配信者が決める項目を持たない。
 * 置けるのはレイドとキーワードの項目だけである（src/admin/form.ts の supportsTownTour）。
 */
export interface TownTourAction {
  type: 'townTour'
}

/**
 * レイドした人と配信者に、合成ページの素材「ツイスター」で対戦させる動作（issue #272）。
 *
 * 対戦の種はその都度ランダムなので、配信者が決める項目を持たない。
 * 置けるのはレイドの項目だけである（src/admin/form.ts の supportsTwister）。
 */
export interface TwisterAction {
  type: 'twister'
}

export type ActionInput = AlertActionInput | ChatAction | AnnounceAction | AiChatAction | ShoutoutAction | TownTourAction | TwisterAction

/**
 * 既定メニューの項目。worker/trigger-menu.ts の TRIGGER_KINDS と同じ並び（worker/ の型は読み込めないのでここで定義する）。
 *
 * 配信者はイベント種別と条件を自由に組み合わせず、この一覧に効果を追加していく。
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
  'commitPushed',
  'pullRequestMerged',
  'pomodoroWorkBegin',
  'pomodoroBreakBegin',
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
  | { kind: 'commitPushed' | 'pullRequestMerged' }
  | { kind: 'pomodoroWorkBegin' | 'pomodoroBreakBegin' }

/** 保存するトリガー。既定メニューの項目と、そのとき行う動作の一覧からなる */
export type TriggerInput = TriggerSource & { actions: ActionInput[] }

/** 保存済みの「アラートを出す」動作（Workerが素材の種類を書き足したもの） */
export type StoredAlertAction = AlertActionInput & { mediaKind: MediaKind }

export type StoredAction = StoredAlertAction | ChatAction | AnnounceAction | AiChatAction | ShoutoutAction | TownTourAction | TwisterAction

/** 保存済みのトリガー */
export type StoredTrigger = TriggerSource & { actions: StoredAction[] }

/** チャンネルポイント報酬の、管理画面から作成・編集する項目（Workerの検証は worker/reward-input.ts） */
export interface RewardInput {
  /** 名前（45文字まで。チャンネル内で重複できない） */
  title: string
  /** 交換に必要なポイント（1以上の整数） */
  cost: number
  /** 視聴者に見せる説明（200文字まで） */
  prompt: string
  /** 視聴者が交換できる状態か */
  isEnabled: boolean
  /** 交換するときにメッセージの入力を求めるか */
  isUserInputRequired: boolean
}

/** チャンネルポイント報酬 */
export interface Reward extends RewardInput {
  id: string
  /** 報酬の画像のURL。アップロードした画像が無ければTwitchの既定の画像（画像はTwitchのダッシュボードでしか変えられない） */
  imageUrl: string
  /** HDADから更新・削除できるか。Twitchは、HDADが作った報酬以外の変更を拒む */
  manageable: boolean
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
  /**
   * 市町村紹介の試し再生。Workerが市町村を1つ引いて合成ページへ押し出し、冒頭の一文を返す。
   *
   * @param userName レイド元とみなす配信者のログイン名（issue #275）。空文字なら見本の名前で流し、共通点は作らせない
   * @param viewers レイド元が連れてきたとみなす人数（共通点の材料）。入れなければ null
   */
  playTownTourDemo(userName: string, viewers: number | null): Promise<string>
  /**
   * ツイスターの試し再生。Workerが相手と配信者の対戦を合成ページへ押し出し、「A vs B」の形の2人を返す。
   * userName に相手とみなす配信者のログイン名を渡すと、その人のアイコンで対戦する。空なら試しの相手で流す
   */
  playTwisterDemo(userName: string): Promise<string>
  /** ツイスターの対戦のあいだ流す BGM の設定。未保存なら BGM を流さない設定が返る */
  twisterSound(): Promise<TwisterSound>
  /** ツイスターの BGM の設定を保存する。Workerが保存したものを返す */
  saveTwisterSound(sound: TwisterSound): Promise<TwisterSound>
  /** 市町村紹介の演出で鳴らす音の設定。未保存ならどの枠も鳴らさない設定が返る */
  townTourSound(): Promise<TownTourSound>
  /** 市町村紹介の音の設定を保存する。Workerが保存したものを返す */
  saveTownTourSound(sound: TownTourSound): Promise<TownTourSound>
  /** 市町村紹介のナレーションの設定（issue #255）。未保存なら読み上げない設定が返る */
  townTourNarration(): Promise<TownTourNarration>
  /** 市町村紹介のナレーションの設定を保存する。Workerが保存したものを返す */
  saveTownTourNarration(narration: TownTourNarration): Promise<TownTourNarration>
  rewards(): Promise<Reward[]>
  /** チャンネルポイント報酬を作る。作られた報酬を返す */
  createReward(input: RewardInput): Promise<Reward>
  /** チャンネルポイント報酬を更新する（HDADが作った報酬だけ）。更新後の報酬を返す */
  updateReward(id: string, input: RewardInput): Promise<Reward>
  /** チャンネルポイント報酬を削除する（HDADが作った報酬だけ。トリガーに使われていれば断られる） */
  removeReward(id: string): Promise<void>
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
  // shoutout と townTour と twister は配信者が決める項目を持たないので、種類だけを見る
  if (value.type === 'shoutout' || value.type === 'townTour' || value.type === 'twister') return true
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
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.title === 'string' &&
  typeof value.cost === 'number' &&
  typeof value.prompt === 'string' &&
  typeof value.isEnabled === 'boolean' &&
  typeof value.isUserInputRequired === 'boolean' &&
  typeof value.imageUrl === 'string' &&
  typeof value.manageable === 'boolean'

/** 報酬の作成・更新の応答から報酬を取り出す */
const readReward = (body: unknown): Reward => {
  if (!isReward(body)) throw new Error('Workerの報酬の応答が想定した形ではありません')
  return body
}

const REWARDS_PATH = '/api/admin/rewards'
const TOWN_TOUR_SOUND_PATH = '/api/admin/town-tour/sound'
const TOWN_TOUR_NARRATION_PATH = '/api/admin/town-tour/narration'
const TWISTER_SOUND_PATH = '/api/admin/twister/sound'

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

    playTownTourDemo: async (userName, viewers) => {
      const body = await call('/api/admin/town-tour/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userName, viewers }),
      })
      if (!isRecord(body) || typeof body.headline !== 'string') throw new Error('Workerの応答に headline がありません')
      return body.headline
    },

    playTwisterDemo: async (userName) => {
      const body = await call('/api/admin/twister/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userName }),
      })
      const players = isRecord(body) && Array.isArray(body.players) ? body.players.map((player: unknown) => (isRecord(player) ? player.name : null)) : []
      const [raider, streamer] = players
      if (players.length !== 2 || typeof raider !== 'string' || typeof streamer !== 'string') throw new Error('Workerの応答に、対戦する2人の名前がありません')
      return `${raider} vs ${streamer}`
    },

    twisterSound: async () => readTwisterSound(await call(TWISTER_SOUND_PATH)),

    saveTwisterSound: async (sound) =>
      readTwisterSound(await call(TWISTER_SOUND_PATH, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sound) })),

    townTourSound: async () => readTownTourSound(await call(TOWN_TOUR_SOUND_PATH)),

    saveTownTourSound: async (sound) =>
      readTownTourSound(
        await call(TOWN_TOUR_SOUND_PATH, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sound) }),
      ),

    townTourNarration: async () => readTownTourNarration(await call(TOWN_TOUR_NARRATION_PATH)),

    saveTownTourNarration: async (narration) =>
      readTownTourNarration(
        await call(TOWN_TOUR_NARRATION_PATH, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(narration) }),
      ),

    rewards: async () => readList(await call(REWARDS_PATH), 'rewards', isReward),

    createReward: async (input) =>
      readReward(await call(REWARDS_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })),

    updateReward: async (id, input) =>
      readReward(
        await call(`${REWARDS_PATH}/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }),
      ),

    removeReward: async (id) => {
      await call(`${REWARDS_PATH}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },

    logout: async () => {
      await call('/api/auth/logout', { method: 'POST' })
    },
  }
}
