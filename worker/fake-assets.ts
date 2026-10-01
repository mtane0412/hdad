/**
 * テスト用の静的アセット（Workers の ASSETS バインディングの代役）
 *
 * パスごとの中身を渡しておくと、そのパスへの fetch にだけ中身を返し、ほかは404を返す。Worker のテストだけが使う
 * （プロダクションコードからは参照しない）。
 */
import type { AssetFetcher } from './http'
import { STATUS } from './http'

export const createFakeAssets = (files: Readonly<Record<string, string>> = {}): AssetFetcher => ({
  fetch: async (request: Request) => {
    const body = files[new URL(request.url).pathname]
    return body === undefined ? new Response(null, { status: STATUS.notFound }) : new Response(body, { status: STATUS.ok })
  },
})
