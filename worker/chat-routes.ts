/**
 * チャットボックス向けの公開経路（OBSのブラウザソースから呼ばれる）
 *
 * チャットボックス（chat/<id>/）は匿名のIRCに直接つないでおり、Twitchのトークンを持たない。
 * そのため、トークンが要る「公式のバッジ画像」と「Cheermote（ビッツの絵）」だけをここで中継する。
 * どちらもTwitchでは誰でも読める公開情報で、スコープも要らない（アプリアクセストークンで足りる）ため、
 * オーバーレイ用キーでは守らない。チャットボックスのURLに合言葉を埋めずに済ませるためでもある。
 *
 * 対象はこのWorkerが扱う配信者（TWITCH_BROADCASTER_ID）に固定で、呼び出し側は配信者を指定しない。
 * 一方でキーが無い＝呼ばれ放題になるので、取得した内容はKVに貯めて、Twitchへの問い合わせを抑える。
 * バッジもCheermoteも滅多に変わらないため、しばらく古い内容を返しても実害はない。
 */
import type { Context } from './http'
import type { KeyValueStore } from './store'
import type { ChatBadgeSet, Cheermote } from './twitch'

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
 * KVに貯めた文字列を読む。
 * 壊れている・古い形のものは「貯まっていない」として扱い、取り直して上書きできるようにする
 * （ここで例外にすると、KVに一度おかしな値が入っただけでこの経路が落ち続けてしまう）。
 */
const readCache = <T>(stored: string | null): CacheEntry<T> | undefined => {
  if (stored === null) return undefined
  try {
    const parsed: unknown = JSON.parse(stored)
    return isCacheEntry<T>(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * KVに貯めた内容を返す。無ければ load で取得して貯める。
 *
 * @param key KVのキー
 * @param now 現在時刻（ミリ秒）
 * @param load 貯まっていないときにTwitchから取得する処理
 */
const withCache = async <T>(store: KeyValueStore, key: string, now: number, load: () => Promise<T>): Promise<T> => {
  const cached = readCache<T>(await store.get(key))
  if (cached !== undefined && cached.expiresAt > now) return cached.value
  const value = await load()
  const entry: CacheEntry<T> = { expiresAt: now + CACHE_TTL_MS, value }
  await store.put(key, JSON.stringify(entry))
  return value
}

const jsonResponse = (body: unknown): Response => Response.json(body, { headers: { 'Cache-Control': CACHE_CONTROL } })

/**
 * GET /api/chat/badges: チャットのバッジ画像の一覧を返す。
 *
 * 全体のバッジと、そのチャンネル固有のバッジ（サブスクの階層・ゲーム内バッジなど）を合わせて返す。
 * 同じ種類が両方にある場合は、チャンネル固有のものを優先する（配信者が用意した絵を出すため）。
 */
export const chatBadges = async ({ env, twitch, now }: Context): Promise<Response> => {
  const broadcasterId = env.TWITCH_BROADCASTER_ID
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

/**
 * GET /api/chat/channel: このWorkerが扱う配信者のチャンネル名を返す。
 *
 * チャットボックスのURLにはチャンネル名を書かない（この配信者のチャンネルに固定する）ため、
 * 接続先をここから受け取る。チャンネル名は公開情報なので、キーもセッションも要らない。
 */
export const chatChannel = async ({ env, twitch, now }: Context): Promise<Response> => {
  const broadcasterId = env.TWITCH_BROADCASTER_ID
  const login = await withCache<string>(env.STORE, `chat-channel:${broadcasterId}`, now, async () =>
    twitch.getUserLogin(await twitch.getAppAccessToken(), broadcasterId),
  )
  return jsonResponse({ login })
}

/** GET /api/chat/cheermotes: Cheermote（ビッツの絵）の一覧を返す */
export const chatCheermotes = async ({ env, twitch, now }: Context): Promise<Response> => {
  const broadcasterId = env.TWITCH_BROADCASTER_ID
  const cheermotes = await withCache<Cheermote[]>(env.STORE, `chat-cheermotes:${broadcasterId}`, now, async () => {
    const accessToken = await twitch.getAppAccessToken()
    return twitch.getCheermotes(accessToken, broadcasterId)
  })
  return jsonResponse({ cheermotes })
}
