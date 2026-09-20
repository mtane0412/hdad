/**
 * サードパーティエモート（7TV・BTTV・FFZ）の取得と、本文への適用
 *
 * 各サービスの公開API（認証不要・CORS許可あり）から、全体用とチャンネル用のエモートを取得し、
 * 「エモート名 → 画像URL」の対応表にまとめる。Twitch公式エモートと違って本文中の位置は届かないため、
 * 空白で区切った単語が対応表にあれば置き換える。
 *
 * 注意:
 * - チャンネルがサービスに未登録だとAPIは404を返す。これは正常な状態なので失敗として扱わない
 * - あるサービスが落ちていてもチャット自体は表示し続けたいので、失敗はサービス名の一覧として呼び出し元へ返す
 *   （呼び出し元が画面に通知する。黙って無視はしない）
 * - 画像URLはAPIの応答をそのまま使わず、IDから自前で組み立てるか、https のURLであることを確認する
 */
import type { Fragment } from './message'

/** エモート名から画像URLを引く表 */
export type EmoteMap = ReadonlyMap<string, string>

/** JSONを取得する関数。404 のときは undefined を返し、それ以外の失敗は例外にする */
export type FetchJson = (url: string) => Promise<unknown>

type EmoteEntry = readonly [name: string, url: string]
type JsonRecord = Readonly<Record<string, unknown>>

const SAFE_ID = /^[A-Za-z0-9]+$/

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const recordOf = (value: unknown, where: string): JsonRecord => {
  if (!isRecord(value)) throw new Error(`${where} がオブジェクトではありません`)
  return value
}

const arrayOf = (value: unknown, where: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${where} が配列ではありません`)
  return value
}

const stringOf = (value: unknown, where: string): string => {
  if (typeof value !== 'string' || value === '') throw new Error(`${where} が文字列ではありません`)
  return value
}

/** https のURLであることを確認する（「//cdn...」形式は https として解釈する） */
const httpsUrlOf = (value: unknown, where: string): string => {
  const url = new URL(stringOf(value, where), 'https://invalid.example')
  if (url.protocol !== 'https:' || url.hostname === 'invalid.example') {
    throw new Error(`${where} が https のURLではありません`)
  }
  return url.href
}

/** 7TV のエモートセット（{ emotes: [{ name, data: { host: { url } } }] }） */
const parseSevenTvSet = (json: unknown): EmoteEntry[] =>
  arrayOf(recordOf(json, '7TV set').emotes, '7TV emotes').map((item) => {
    const emote = recordOf(item, '7TV emote')
    const host = recordOf(recordOf(emote.data, '7TV data').host, '7TV host')
    return [stringOf(emote.name, '7TV name'), `${httpsUrlOf(host.url, '7TV host.url')}/2x.webp`]
  })

/** 7TV のユーザー情報。エモートセットを未設定のユーザーは emote_set が null になる */
const parseSevenTvUser = (json: unknown): EmoteEntry[] => {
  const emoteSet = recordOf(json, '7TV user').emote_set
  return emoteSet === null || emoteSet === undefined ? [] : parseSevenTvSet(emoteSet)
}

/** BTTV のエモート一覧（[{ id, code }]） */
const parseBttvList = (json: unknown): EmoteEntry[] =>
  arrayOf(json, 'BTTV emotes').map((item) => {
    const emote = recordOf(item, 'BTTV emote')
    const id = stringOf(emote.id, 'BTTV id')
    if (!SAFE_ID.test(id)) throw new Error('BTTV id に想定外の文字が含まれています')
    return [stringOf(emote.code, 'BTTV code'), `https://cdn.betterttv.net/emote/${id}/2x`]
  })

const parseBttvUser = (json: unknown): EmoteEntry[] => {
  const user = recordOf(json, 'BTTV user')
  return [...parseBttvList(user.sharedEmotes), ...parseBttvList(user.channelEmotes)]
}

/** FFZ のセット（{ emoticons: [{ name, urls: { '1', '2', '4' } }] }）。2倍サイズがなければ等倍を使う */
const parseFfzSet = (json: unknown): EmoteEntry[] =>
  arrayOf(recordOf(json, 'FFZ set').emoticons, 'FFZ emoticons').map((item) => {
    const emote = recordOf(item, 'FFZ emoticon')
    const urls = recordOf(emote.urls, 'FFZ urls')
    return [stringOf(emote.name, 'FFZ name'), httpsUrlOf(urls['2'] ?? urls['1'], 'FFZ url')]
  })

/** FFZ の全体用。sets には既定でないセットも含まれるため、default_sets に挙がったものだけを使う */
const parseFfzGlobal = (json: unknown): EmoteEntry[] => {
  const root = recordOf(json, 'FFZ global')
  const sets = recordOf(root.sets, 'FFZ sets')
  return arrayOf(root.default_sets, 'FFZ default_sets').flatMap((setId) => parseFfzSet(sets[String(setId)]))
}

const parseFfzRoom = (json: unknown): EmoteEntry[] =>
  Object.values(recordOf(recordOf(json, 'FFZ room').sets, 'FFZ sets')).flatMap(parseFfzSet)

interface EmoteProvider {
  readonly name: string
  readonly globalUrl: string
  channelUrl(roomId: string): string
  parseGlobal(json: unknown): EmoteEntry[]
  parseChannel(json: unknown): EmoteEntry[]
}

/** 同じ名前のエモートは、後ろのサービスほど優先する（一般的なチャット拡張の優先順: FFZ < BTTV < 7TV） */
const PROVIDERS: readonly EmoteProvider[] = [
  {
    name: 'FFZ',
    globalUrl: 'https://api.frankerfacez.com/v1/set/global',
    channelUrl: (roomId) => `https://api.frankerfacez.com/v1/room/id/${roomId}`,
    parseGlobal: parseFfzGlobal,
    parseChannel: parseFfzRoom,
  },
  {
    name: 'BTTV',
    globalUrl: 'https://api.betterttv.net/3/cached/emotes/global',
    channelUrl: (roomId) => `https://api.betterttv.net/3/cached/users/twitch/${roomId}`,
    parseGlobal: parseBttvList,
    parseChannel: parseBttvUser,
  },
  {
    name: '7TV',
    globalUrl: 'https://7tv.io/v3/emote-sets/global',
    channelUrl: (roomId) => `https://7tv.io/v3/users/twitch/${roomId}`,
    parseGlobal: parseSevenTvSet,
    parseChannel: parseSevenTvUser,
  },
]

/** 1サービス分を取得する。全体用を先、チャンネル用を後に並べる（後ろが優先される） */
const loadProvider = async (
  provider: EmoteProvider,
  roomId: string,
  fetchJson: FetchJson,
): Promise<EmoteEntry[]> => {
  const [globalJson, channelJson] = await Promise.all([
    fetchJson(provider.globalUrl),
    fetchJson(provider.channelUrl(roomId)),
  ])
  if (globalJson === undefined) throw new Error(`${provider.name} の全体用エモートが見つかりません`)
  return [
    ...provider.parseGlobal(globalJson),
    ...(channelJson === undefined ? [] : provider.parseChannel(channelJson)),
  ]
}

/** 取得結果 */
export interface ThirdPartyEmotes {
  readonly emotes: EmoteMap
  /** 取得に失敗したサービスの名前 */
  readonly failures: readonly string[]
}

/**
 * 3サービスのエモートをまとめて取得する。
 *
 * @param roomId TwitchのチャンネルID（ROOMSTATE の room-id）
 * @param fetchJson JSONの取得関数（テストでは偽物に差し替える）
 */
export const loadThirdPartyEmotes = async (
  roomId: string,
  fetchJson: FetchJson,
): Promise<ThirdPartyEmotes> => {
  const results = await Promise.allSettled(
    PROVIDERS.map((provider) => loadProvider(provider, roomId, fetchJson)),
  )
  const emotes = new Map<string, string>()
  const failures: string[] = []
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      for (const [name, url] of result.value) emotes.set(name, url)
    } else {
      failures.push(PROVIDERS[index]?.name ?? '不明なサービス')
    }
  })
  return { emotes, failures: failures.sort() }
}

/** fetch を使った FetchJson の実装 */
export const fetchJson: FetchJson = async (url) => {
  const NOT_FOUND = 404
  const response = await fetch(url)
  if (response.status === NOT_FOUND) return undefined
  if (!response.ok) throw new Error(`${url} の取得に失敗しました（HTTP ${response.status}）`)
  return response.json()
}

/**
 * 本文中の単語のうち、対応表にあるものをエモートの断片に置き換える。
 * Twitch公式エモートの断片には手を付けない。
 */
export const applyEmotes = (fragments: readonly Fragment[], emotes: EmoteMap): Fragment[] =>
  fragments.flatMap((fragment): Fragment[] => {
    if (fragment.type !== 'text') return [fragment]
    const result: Fragment[] = []
    let pendingText = ''
    // 空白も要素として残る形で分割し、置き換えなかった部分は元の空白ごと1つの文字断片に戻す
    for (const token of fragment.text.split(/(\s+)/)) {
      const url = emotes.get(token)
      if (url === undefined) {
        pendingText += token
        continue
      }
      if (pendingText !== '') result.push({ type: 'text', text: pendingText })
      pendingText = ''
      result.push({ type: 'emote', name: token, url })
    }
    if (pendingText !== '') result.push({ type: 'text', text: pendingText })
    return result
  })
