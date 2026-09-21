/**
 * Cheermote（ビッツの絵）の取得と、本文への適用
 *
 * Cheer の書き込みは、本文に「接頭辞＋ビッツ数」という単語が入って届く（例: cheer500・Kappa100）。
 * どの接頭辞が使えるか・ビッツ数ごとにどの絵になるかはチャンネルごとに違い、Twitchのトークンがないと取れないため、
 * Workerの公開API（/api/chat/cheermotes）を経由して取得する。
 *
 * 公式エモートと違って本文中の位置は届かないので、空白で区切った単語として見つけて置き換える。
 *
 * 注意: 応答が想定した形でなければエラーにする（Fail-Fast）。
 */
import { createCaller, isRecord, readList } from '../core/api'
import type { Fragment } from './message'

/** Cheermote の段階（ビッツ数が多いほど上の段階になる） */
export interface CheermoteTier {
  readonly minBits: number
  /** 段階の色（#rrggbb）。ビッツ数の文字色に使う */
  readonly color: string
  readonly imageUrl: string
}

/** Cheermote 1種類 */
export interface Cheermote {
  /** 本文に書かれる接頭辞（例: Cheer）。表記ゆれがあるため、引くときは小文字にする */
  readonly prefix: string
  readonly tiers: readonly CheermoteTier[]
}

/** 小文字の接頭辞から Cheermote を引く表 */
export type CheermoteMap = ReadonlyMap<string, Cheermote>

/** 本文の単語が「接頭辞＋ビッツ数」の形かどうかを見る */
const CHEER_TOKEN = /^([A-Za-z]+)(\d+)$/

const isTier = (value: unknown): value is CheermoteTier =>
  isRecord(value) && typeof value.minBits === 'number' && typeof value.color === 'string' && typeof value.imageUrl === 'string'

const isCheermote = (value: unknown): value is Cheermote =>
  isRecord(value) && typeof value.prefix === 'string' && Array.isArray(value.tiers) && value.tiers.every(isTier)

/**
 * Cheermote の一覧を取得する。
 *
 * @param broadcasterId TwitchのチャンネルID（ROOMSTATE の room-id）
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 */
export const loadCheermotes = async (broadcasterId: string, fetchImpl: typeof fetch): Promise<CheermoteMap> => {
  const body = await createCaller(fetchImpl)(`/api/chat/cheermotes?broadcaster=${encodeURIComponent(broadcasterId)}`)
  const cheermotes = readList(body, 'cheermotes', isCheermote)
  return new Map(cheermotes.map((cheermote) => [cheermote.prefix.toLowerCase(), cheermote]))
}

/** ビッツ数に見合う段階（そのビッツ数以下で最も大きい minBits の段階）を選ぶ。どれにも届かなければ undefined */
const tierOf = (cheermote: Cheermote, bits: number): CheermoteTier | undefined =>
  cheermote.tiers.filter((tier) => tier.minBits <= bits).reduce<CheermoteTier | undefined>((best, tier) => (best === undefined || tier.minBits > best.minBits ? tier : best), undefined)

/** 単語が Cheermote なら、その断片にする。そうでなければ undefined */
const toCheerFragment = (token: string, cheermotes: CheermoteMap): Fragment | undefined => {
  const matched = CHEER_TOKEN.exec(token)
  if (!matched) return undefined
  const [, prefix = '', amountText = ''] = matched
  const cheermote = cheermotes.get(prefix.toLowerCase())
  if (cheermote === undefined) return undefined
  const amount = Number(amountText)
  const tier = tierOf(cheermote, amount)
  if (tier === undefined) return undefined
  return { type: 'cheer', name: token, url: tier.imageUrl, amount, color: tier.color }
}

/**
 * 本文中の「接頭辞＋ビッツ数」の単語を、Cheermote の断片に置き換える。
 * 公式エモート・サードパーティエモートの断片には手を付けない。
 */
export const applyCheermotes = (fragments: readonly Fragment[], cheermotes: CheermoteMap): Fragment[] =>
  fragments.flatMap((fragment): Fragment[] => {
    if (fragment.type !== 'text' || cheermotes.size === 0) return [fragment]
    const result: Fragment[] = []
    let pendingText = ''
    // 空白も要素として残る形で分割し、置き換えなかった部分は元の空白ごと1つの文字断片に戻す
    for (const token of fragment.text.split(/(\s+)/)) {
      const cheer = toCheerFragment(token, cheermotes)
      if (cheer === undefined) {
        pendingText += token
        continue
      }
      if (pendingText !== '') result.push({ type: 'text', text: pendingText })
      pendingText = ''
      result.push(cheer)
    }
    if (pendingText !== '') result.push({ type: 'text', text: pendingText })
    return result
  })
