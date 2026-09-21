/**
 * テスト用のメモリ上のストア
 *
 * KVの代わりに Map へ読み書きする。Worker のテストだけが使う（プロダクションコードからは参照しない）。
 */
import type { KeyValueStore } from './store'

/** 中身を直接確かめられるよう、Map も一緒に返す */
export const createFakeStore = (initial: Record<string, string> = {}): KeyValueStore & { entries: Map<string, string> } => {
  const entries = new Map(Object.entries(initial))
  return {
    entries,
    get: async (key) => entries.get(key) ?? null,
    put: async (key, value) => {
      entries.set(key, value)
    },
    delete: async (key) => {
      entries.delete(key)
    },
  }
}
