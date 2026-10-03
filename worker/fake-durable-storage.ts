/**
 * テスト用の Durable Object の保管庫
 *
 * Durable Object の ctx.storage の代わりに、値を Map に持つ。Worker のテストだけが使う
 * （プロダクションコードからは参照しない）。
 */
import type { DurableStorage } from './overlay-key'

/** 中身を直接確かめられるよう、Map も一緒に返す */
export const createFakeDurableStorage = (initial: Record<string, string> = {}): DurableStorage & { values: Map<string, string> } => {
  const values = new Map(Object.entries(initial))
  return {
    values,
    get: async (key) => values.get(key),
    put: async (key, value) => {
      values.set(key, value)
    },
  }
}
