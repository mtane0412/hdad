/**
 * テスト用の、背景の1枚を置く storage
 *
 * Durable Object の storage の代わりに Map を使う。Worker のテストだけが使う（プロダクションコードからは参照しない）。
 */
import type { BackgroundStorage } from './draw-background'

/** 書いた鍵の一覧も確かめられるようにして返す */
export const createFakeBackgroundStorage = (): BackgroundStorage & { 鍵たち: () => string[] } => {
  const 中身 = new Map<string, unknown>()
  return {
    鍵たち: () => [...中身.keys()].sort(),
    get: async <T,>(key: string) => 中身.get(key) as T | undefined,
    put: async (entries: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(entries)) 中身.set(key, value)
    },
    delete: async (keys: string[]) => keys.filter((key) => 中身.delete(key)).length,
  }
}
