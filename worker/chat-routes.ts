/**
 * チャットボックス向けの公開経路（OBSのブラウザソースから呼ばれる）
 *
 * チャットボックス（chat/<id>/）は匿名のIRCに直接つないでおり、Twitchのトークンを持たない。
 * そのため、トークンが要る「公式のバッジ画像」と「Cheermote（ビッツの絵）」だけをここで中継する。
 * どちらもTwitchでは誰でも読める公開情報で、スコープも要らない（アプリアクセストークンで足りる）ため、
 * オーバーレイ用キーでは守らない。チャットボックスのURLに合言葉を埋めずに済ませるためでもある。
 *
 * 一方でキーが無い＝呼ばれ放題になるので、取得した内容はKVに貯めて、Twitchへの問い合わせを抑える。
 * バッジもCheermoteも滅多に変わらないため、しばらく古い内容を返しても実害はない。
 */
import { HttpError, STATUS, type Context } from './http'
import type { KeyValueStore } from './store'
import type { ChatBadgeSet, Cheermote } from './twitch'

/** TwitchのユーザーID（数字のみ）。チャットボックスはIRCの ROOMSTATE で受け取ったIDをそのまま渡してくる */
const BROADCASTER_ID = /^\d+$/
/** KVに貯めた内容を使い回す時間（ミリ秒）。バッジもCheermoteも滅多に変わらない */
const CACHE_TTL_MS = 60 * 60 * 1000
/** ブラウザと共有キャッシュに持たせる時間（秒）。KVの貯め置きと同じ長さにする */
const CACHE_CONTROL = `public, max-age=${CACHE_TTL_MS / 1000}`

/** KVに貯める形。取り出すときに現在時刻と比べて、古ければ取り直す */
interface CacheEntry<T> {
  readonly expiresAt: number
  readonly value: T
}

const isCacheEntry = <T>(value: unknown): value is CacheEntry<T> =>
  typeof value === 'object' && value !== null && typeof (value as CacheEntry<T>).expiresAt === 'number'

/**
 * KVに貯めた内容を返す。無ければ load で取得して貯める。
 *
 * @param key KVのキー
 * @param now 現在時刻（ミリ秒）
 * @param load 貯まっていないときにTwitchから取得する処理
 */
const withCache = async <T>(store: KeyValueStore, key: string, now: number, load: () => Promise<T>): Promise<T> => {
  const stored = await store.get(key)
  if (stored !== null) {
    const parsed: unknown = JSON.parse(stored)
    // 貯めた内容が読めない形だった場合は、取り直して上書きする
    if (isCacheEntry<T>(parsed) && parsed.expiresAt > now) return parsed.value
  }
  const value = await load()
  const entry: CacheEntry<T> = { expiresAt: now + CACHE_TTL_MS, value }
  await store.put(key, JSON.stringify(entry))
  return value
}

/** ?broadcaster= に指定された配信者のIDを読む */
const requireBroadcasterId = (url: URL): string => {
  const broadcaster = url.searchParams.get('broadcaster') ?? ''
  if (!BROADCASTER_ID.test(broadcaster)) {
    throw new HttpError(
      STATUS.badRequest,
      'invalid-broadcaster',
      '?broadcaster= に、数字のTwitchユーザーID（チャットのチャンネルID）を指定してください',
    )
  }
  return broadcaster
}

const jsonResponse = (body: unknown): Response => Response.json(body, { headers: { 'Cache-Control': CACHE_CONTROL } })

/**
 * GET /api/chat/badges?broadcaster=: チャットのバッジ画像の一覧を返す。
 *
 * 全体のバッジと、そのチャンネル固有のバッジ（サブスクの階層・ゲーム内バッジなど）を合わせて返す。
 * 同じ種類が両方にある場合は、チャンネル固有のものを優先する（配信者が用意した絵を出すため）。
 */
export const chatBadges = async ({ url, env, twitch, now }: Context): Promise<Response> => {
  const broadcasterId = requireBroadcasterId(url)
  const badges = await withCache<ChatBadgeSet[]>(env.STORE, `chat-badges:${broadcasterId}`, now, async () => {
    const accessToken = await twitch.getAppAccessToken()
    const [global, channel] = await Promise.all([
      twitch.getChatBadges(accessToken, undefined),
      twitch.getChatBadges(accessToken, broadcasterId),
    ])
    const merged = new Map(global.map((set) => [set.setId, set]))
    for (const set of channel) merged.set(set.setId, set)
    return [...merged.values()]
  })
  return jsonResponse({ badges })
}

/** GET /api/chat/cheermotes?broadcaster=: Cheermote（ビッツの絵）の一覧を返す */
export const chatCheermotes = async ({ url, env, twitch, now }: Context): Promise<Response> => {
  const broadcasterId = requireBroadcasterId(url)
  const cheermotes = await withCache<Cheermote[]>(env.STORE, `chat-cheermotes:${broadcasterId}`, now, async () => {
    const accessToken = await twitch.getAppAccessToken()
    return twitch.getCheermotes(accessToken, broadcasterId)
  })
  return jsonResponse({ cheermotes })
}
