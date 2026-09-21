/**
 * オーバーレイ用キー
 *
 * OBSのブラウザソースのURLに載せる合言葉。Twitchのトークンの代わりにこれをURLへ載せることで、
 * URLが漏れてもTwitchアカウントには影響せず、キーを発行し直せば無効にできる。
 */
import { randomToken, timingSafeEqual } from './secret'
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
