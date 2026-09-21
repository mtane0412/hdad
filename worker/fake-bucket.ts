/**
 * テスト用のメモリ上の素材置き場
 *
 * R2の代わりに Map へ読み書きする。Worker のテストだけが使う（プロダクションコードからは参照しない）。
 */
import type { MediaBucket, MediaObject } from './media-bucket'

interface Entry {
  bytes: ArrayBuffer
  object: MediaObject
}

/** 中身を直接確かめられるよう、Map も一緒に返す */
export const createFakeBucket = (uploadedAt = new Date('2026-09-21T12:00:00Z')): MediaBucket & { entries: Map<string, Entry> } => {
  const entries = new Map<string, Entry>()
  return {
    entries,
    put: async (key, value, options) => {
      entries.set(key, { bytes: value, object: { key, size: value.byteLength, uploaded: uploadedAt, ...options } })
    },
    get: async (key) => {
      const entry = entries.get(key)
      return entry ? { ...entry.object, body: new Response(entry.bytes).body! } : null
    },
    head: async (key) => entries.get(key)?.object ?? null,
    list: async () => ({ objects: [...entries.values()].map((entry) => entry.object), truncated: false }),
    delete: async (key) => {
      entries.delete(key)
    },
  }
}
