/**
 * テスト用のトークンの保管庫
 *
 * Durable Object（TokenVault）の代わりに、同じ要求の処理（handleTokenVaultRequest）をメモリ上の保管で動かす。
 * Worker のテストだけが使う（プロダクションコードからは参照しない）。
 */
import { handleTokenVaultRequest, type TokenVaultNamespace, type TokenVaultStorage } from './token-vault'

/** Durable Object の同期の保管（ctx.storage.kv）の代わり。中身を直接確かめられるよう、Map も一緒に返す */
export const createFakeTokenStorage = (initial: Record<string, string> = {}): TokenVaultStorage & { values: Map<string, string> } => {
  const values = new Map(Object.entries(initial))
  return {
    values,
    get: (key) => values.get(key),
    put: (key, value) => {
      values.set(key, value)
    },
    delete: (key) => values.delete(key),
  }
}

/**
 * 保管庫の入口（Durable Object の名前空間）の代わり。
 *
 * @param initial 保管の初期値。鍵は役割（broadcaster・bot）で、値は保存したトークンのJSON
 */
export const createFakeTokenVault = (initial: Record<string, string> = {}): { namespace: TokenVaultNamespace; values: Map<string, string> } => {
  const storage = createFakeTokenStorage(initial)
  const id: DurableObjectId = { toString: () => 'tokens', equals: (other) => other.toString() === 'tokens', name: 'tokens' }
  return {
    values: storage.values,
    namespace: {
      idFromName: () => id,
      get: () => ({ fetch: (request: Request) => handleTokenVaultRequest(storage, request) }),
    },
  }
}
