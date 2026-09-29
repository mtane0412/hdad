/**
 * コメントビューアーのWorkerの呼び出し（アイコンの問い合わせ）
 *
 * 発言や出来事は1件ずつ WebSocket で届く（socket.ts）が、発言した人のアイコンは添えられていない。
 * 1件ごとに添えると発言のたびに Twitch を呼ぶことになるので、画面が初めて見た人のIDだけをまとめて
 * Worker（GET /api/admin/comments/icons）へ問い合わせ、画面を開いているあいだ手元に覚えておく。
 *
 * バッジの画像はチャットボックスと同じもの（src/chat/badges.ts）を使う。
 *
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: 応答が想定した形でなければエラーにする（Fail-Fast）。
 */
import { loadBadges, type BadgeMap } from '../chat/badges'
import { createCaller, isRecord } from '../core/api'
import type { FeedEntry } from './feed'

const ICONS_PATH = '/api/admin/comments/icons'

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
