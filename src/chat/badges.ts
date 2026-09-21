/**
 * 公式のチャットバッジ画像の取得
 *
 * バッジ画像はTwitchのトークンがないと取れないため、Workerの公開API（/api/chat/badges）を経由して取得する。
 * IRCの badges タグは「種類/版」（例: subscriber/12）で届くので、その組から画像を引ける表にまとめる。
 *
 * 注意: 応答が想定した形でなければエラーにする（Fail-Fast）。黙って空の表にすると、
 * バッジが出ない原因が「取得できていない」のか「そもそも付いていない」のか分からなくなる。
 */
import { createCaller, isRecord, readList } from '../core/api'
import type { BadgeRef } from './message'
import type { BadgeImage } from './view'

/** 「種類/版」から公式のバッジ画像を引く表 */
export type BadgeMap = ReadonlyMap<string, BadgeImage>

/** 表のキー。IRCの badges タグの書き方に合わせる */
export const badgeKey = ({ setId, versionId }: BadgeRef): string => `${setId}/${versionId}`

interface BadgeVersionResponse {
  readonly id: string
  readonly imageUrl: string
  readonly title: string
}

interface BadgeSetResponse {
  readonly setId: string
  readonly versions: readonly BadgeVersionResponse[]
}

const isBadgeVersion = (value: unknown): value is BadgeVersionResponse =>
  isRecord(value) && typeof value.id === 'string' && typeof value.imageUrl === 'string' && typeof value.title === 'string'

const isBadgeSet = (value: unknown): value is BadgeSetResponse =>
  isRecord(value) && typeof value.setId === 'string' && Array.isArray(value.versions) && value.versions.every(isBadgeVersion)

/**
 * 公式のバッジ画像を取得する。
 *
 * @param broadcasterId TwitchのチャンネルID（ROOMSTATE の room-id）
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 */
export const loadBadges = async (broadcasterId: string, fetchImpl: typeof fetch): Promise<BadgeMap> => {
  const body = await createCaller(fetchImpl)(`/api/chat/badges?broadcaster=${encodeURIComponent(broadcasterId)}`)
  const sets = readList(body, 'badges', isBadgeSet)
  const badges = new Map<string, BadgeImage>()
  for (const set of sets) {
    for (const version of set.versions) {
      badges.set(badgeKey({ setId: set.setId, versionId: version.id }), { url: version.imageUrl, title: version.title })
    }
  }
  return badges
}
