/**
 * オーバーレイ用キー
 *
 * OBSのブラウザソースのURLに載せる合言葉。Twitchのトークンの代わりにこれをURLへ載せることで、
 * URLが漏れてもTwitchアカウントには影響せず、キーを発行し直せば無効にできる。
 *
 * WebSocketの接続はつないだときに一度だけキーを確かめるため、発行し直したときは接続を保持する Durable Object にも
 * 知らせて古いキーの接続を閉じさせる（worker/admin-routes.ts の postOverlayKey）。KVの反映待ちのあいだは古いキーでも
 * Worker の確認を通ってしまうので、Durable Object は新しいキーの目印（overlayKeyTag）を自分の保管庫に覚え、
 * 目印の違う接続を受け入れない。Durable Object の保管庫は書いた直後から読めるため、反映待ちの抜け道にならない。
 */
import { randomToken, sha256Hex, timingSafeEqual } from './secret'
import type { KeyValueStore } from './store'

const OVERLAY_KEY = 'overlay-key'

export const loadOverlayKey = (store: KeyValueStore): Promise<string | null> => store.get(OVERLAY_KEY)

/** キーが未発行なら発行する。発行済みなら変えない（OBSに貼ったURLを無効にしないため） */
export const ensureOverlayKey = async (store: KeyValueStore): Promise<void> => {
  if ((await loadOverlayKey(store)) === null) await store.put(OVERLAY_KEY, randomToken())
}

/**
 * キーを発行し直して返す。古いキーを含むURL（OBSに貼ったもの）は使えなくなる。
 *
 * 注意: KVの反映には最大60秒ほどかかるため、古いキーがその間だけ通ることがある。
 */
export const rotateOverlayKey = async (store: KeyValueStore): Promise<string> => {
  const key = randomToken()
  await store.put(OVERLAY_KEY, key)
  return key
}

/** 渡されたキーが発行済みのキーと一致するか。未発行ならどんなキーも一致しない */
export const isValidOverlayKey = async (store: KeyValueStore, key: string): Promise<boolean> => {
  const issued = await loadOverlayKey(store)
  return issued !== null && timingSafeEqual(key, issued)
}

/** 目印の長さ。キーそのものを持ち出さずに、どのキーで開かれた接続かを見分けられれば足りる */
const KEY_TAG_LENGTH = 16

/** Worker が Durable Object へ目印を伝えるクエリ。利用者の送ってきた値は Worker が上書きする */
export const KEY_TAG_PARAM = 'keyTag'

/** Durable Object の保管庫で、いまのキーの目印を覚えておく名前 */
const CURRENT_KEY_TAG = 'overlay-key-tag'

/** キーから作る目印（SHA-256 の要約の先頭）。Durable Object にキーそのものを渡さずに済むように使う */
export const overlayKeyTag = async (key: string): Promise<string> => (await sha256Hex(key)).slice(0, KEY_TAG_LENGTH)

/**
 * Durable Object の保管庫のうち、目印の読み書きに使うもの。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * Cloudflare の DurableObjectStorage はこの形を満たす。
 */
export interface DurableStorage {
  get(key: string): Promise<unknown>
  put(key: string, value: string): Promise<void>
}

/**
 * オーバーレイ用キーで開こうとしている接続を受け入れてよいか。
 *
 * 一度も発行し直していなければ目印を覚えていないので、Worker の確認（requireOverlayKey）に任せる。
 */
export const isCurrentKeyTag = async (storage: DurableStorage, tag: string | null): Promise<boolean> => {
  const current = await storage.get(CURRENT_KEY_TAG)
  return current === undefined || current === tag
}

/**
 * 発行し直しの知らせの本文から新しい目印を読み、覚える。
 *
 * @returns 覚えられたら true。本文に目印がなければ false（覚えずに、呼び出し側が400を返す）
 */
export const rememberKeyTag = async (storage: DurableStorage, request: Request): Promise<boolean> => {
  const body: unknown = await request.json().catch(() => null)
  const tag = typeof body === 'object' && body !== null && 'keyTag' in body ? body.keyTag : undefined
  if (typeof tag !== 'string' || tag === '') return false
  await storage.put(CURRENT_KEY_TAG, tag)
  return true
}

/** Durable Object へ発行し直しを知らせるリクエストを作る */
export const revokeRequest = (url: string, tag: string): Request =>
  new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keyTag: tag }) })
