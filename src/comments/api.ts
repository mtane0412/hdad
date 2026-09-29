/**
 * コメントビューアーのWorkerの呼び出し（アイコンの問い合わせ）
 *
 * 発言や出来事は1件ずつ WebSocket で届く（socket.ts）が、発言した人のアイコンは添えられていない。
 * 1件ごとに添えると発言のたびに Twitch を呼ぶことになるので、画面が初めて見た人のIDだけをまとめて
 * Worker（GET /api/admin/comments/icons）へ問い合わせ、画面を開いているあいだ手元に覚えておく。
 *
 * バッジの画像はチャットボックスと同じもの（src/chat/badges.ts）を使う。
 * モデレーターの操作（発言の削除・タイムアウト・BAN）は POST /api/admin/comments/moderation に頼み、botの権限で行われる。
 * タイムアウトの長さは Worker が決め、応答で知らせてくる（画面に同じ数を持たない）。
 * チャットの送信は POST /api/admin/comments/messages に頼み、配信者本人として送られる。
 * 発言の既読・未読の付け替えは POST /api/admin/comments/reads に頼む。付け替えた印は、ほかの1件と同じく
 * 配送先から WebSocket で届いた時点で並びに付く（画面が先回りして付けない）。
 * 設定（しばらく未読の発言を目立たせるか）は /api/admin/comments/settings で読み書きする。
 *
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: 応答が想定した形でなければエラーにする（Fail-Fast）。
 */
import { loadBadges, type BadgeMap } from '../chat/badges'
import { createCaller, isRecord } from '../core/api'
import type { FeedEntry } from './feed'

const ICONS_PATH = '/api/admin/comments/icons'
const MODERATION_PATH = '/api/admin/comments/moderation'
const MESSAGES_PATH = '/api/admin/comments/messages'
const READS_PATH = '/api/admin/comments/reads'
const SETTINGS_PATH = '/api/admin/comments/settings'

/** コメントビューアーの設定。worker/comment-config.ts の CommentSettings と合わせる */
export interface CommentSettings {
  /** しばらく未読のままの発言を目立たせるか */
  highlightUnread: boolean
}

/** 応答から設定を読む。想定した形でなければエラーにする */
const readSettings = (body: unknown): CommentSettings => {
  if (isRecord(body) && typeof body.highlightUnread === 'boolean') return { highlightUnread: body.highlightUnread }
  throw new Error(`Workerの ${SETTINGS_PATH} の応答が想定した形ではありません`)
}

/** 画面から選べる処分。worker/comment-routes.ts の MODERATION_ACTIONS と合わせる */
export type ModerationAction = 'delete' | 'timeout' | 'ban'

/** 処分の結果。タイムアウトなら Worker が決めた長さ（秒）が添えられる */
export type ModerationResult = { action: 'delete' } | { action: 'timeout'; durationSeconds: number } | { action: 'ban' }

/** 処分の対象 */
export interface ModerationTarget {
  /** 削除する発言のID（タイムアウト・BANでは、Workerは発言を先に削除しない） */
  messageId: string
  /** 処分する人のユーザーID */
  userId: string
}

/** 応答から処分の結果を読む。想定した形でなければエラーにする */
const readModerationResult = (body: unknown): ModerationResult => {
  if (isRecord(body)) {
    if (body.action === 'delete' || body.action === 'ban') return { action: body.action }
    if (body.action === 'timeout' && typeof body.durationSeconds === 'number') return { action: 'timeout', durationSeconds: body.durationSeconds }
  }
  throw new Error(`Workerの ${MODERATION_PATH} の応答が想定した形ではありません`)
}

/** 1度に問い合わせられる人数。worker/comment-routes.ts の MAX_ICON_USERS と合わせる */
export const MAX_ICON_USERS = 100

export interface CommentApi {
  /**
   * ユーザーIDごとのアイコンのURLを引く。Twitch が返さなかった人（消えたアカウントなど）は含まれない。
   *
   * @param userIds 1〜MAX_ICON_USERS 人
   */
  loadIcons(userIds: readonly string[]): Promise<Record<string, string>>
  /** 公式のバッジ画像の表（チャットボックスと同じ /api/chat/badges から引く） */
  loadBadges(): Promise<BadgeMap>
  /**
   * 選んだ処分を、botの権限で行ってもらう。
   *
   * @throws ApiError botが未接続・モデレーターでないなど、Workerが断った
   */
  moderate(action: ModerationAction, target: ModerationTarget): Promise<ModerationResult>
  /**
   * 配信者本人としてチャットへ1通送る（文言の検証は Worker が行う）。
   *
   * @throws ApiError 配信者が許可を取り直していない・Twitchが送らなかったなど、Workerが断った
   */
  send(message: string): Promise<void>
  /**
   * 発言を既読にする・未読に戻す。印は配送先から届いた付け替えで並びに付く。
   *
   * @throws ApiError Workerが記録できなかった・画面へ知らせられなかった
   */
  markRead(messageId: string, read: boolean): Promise<void>
  /** 設定を読む（未保存なら Worker が既定の設定を返す） */
  loadSettings(): Promise<CommentSettings>
  /** 設定を保存し、保存された設定を受け取る */
  saveSettings(settings: CommentSettings): Promise<CommentSettings>
}

export const createCommentApi = (fetchImpl: typeof fetch): CommentApi => {
  const call = createCaller(fetchImpl)
  return {
    loadIcons: async (userIds) => {
      const query = new URLSearchParams(userIds.map((userId) => ['user_id', userId]))
      const body = await call(`${ICONS_PATH}?${query.toString()}`)
      const icons: unknown = isRecord(body) ? body.icons : undefined
      if (!isRecord(icons) || !Object.values(icons).every((url) => typeof url === 'string')) {
        throw new Error(`Workerの ${ICONS_PATH} の応答が想定した形ではありません`)
      }
      return Object.fromEntries(Object.entries(icons).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    },
    loadBadges: () => loadBadges(fetchImpl),
    send: async (message) => {
      await call(MESSAGES_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) })
    },
    markRead: async (messageId, read) => {
      await call(READS_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageId, read }) })
    },
    loadSettings: async () => readSettings(await call(SETTINGS_PATH)),
    saveSettings: async (settings) =>
      readSettings(await call(SETTINGS_PATH, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) })),
    moderate: async (action, { messageId, userId }) =>
      readModerationResult(
        await call(MODERATION_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, messageId, userId }),
        }),
      ),
  }
}

/**
 * 並びの中から、まだアイコンを問い合わせていない人のIDを選ぶ（重ねず、1度に問い合わせられる人数まで）。
 *
 * @param asked すでに問い合わせた人のID（引けなかった人も含める。同じ人を何度も問い合わせないため）
 */
export const pickUnknownUserIds = (entries: readonly FeedEntry[], asked: ReadonlySet<string>): string[] => {
  const picked = new Set<string>()
  for (const { item } of entries) {
    const user = item.user
    if (user === null || asked.has(user.id)) continue
    picked.add(user.id)
    if (picked.size === MAX_ICON_USERS) break
  }
  return [...picked]
}

/** 1分の秒数 */
const SECONDS_PER_MINUTE = 60

/** タイムアウトの長さを、分で割り切れれば分、そうでなければ秒で言う */
const durationLabel = (seconds: number): string =>
  seconds % SECONDS_PER_MINUTE === 0 ? `${seconds / SECONDS_PER_MINUTE}分` : `${seconds}秒`

/** 行った処分を、配信者に伝える文にする */
export const describeModeration = (result: ModerationResult, name: string): string => {
  switch (result.action) {
    case 'delete':
      return `${name} さんの発言を削除しました`
    case 'timeout':
      return `${name} さんを${durationLabel(result.durationSeconds)}タイムアウトしました`
    case 'ban':
      return `${name} さんをBANしました`
  }
}
