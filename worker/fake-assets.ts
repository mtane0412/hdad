/**
 * テスト用の静的アセット（Workers の ASSETS バインディングの代役）
 *
 * パスごとの中身を渡しておくと、そのパスへの fetch にだけ中身を返し、ほかは404を返す。Worker のテストだけが使う
 * （プロダクションコードからは参照しない）。中身の種類（Content-Type）を確かめたいときは { body, contentType } で渡す。
 */
import type { AssetFetcher } from './http'
import { STATUS } from './http'

/** 静的アセット1つ。文字列だけなら中身の種類は付けない */
export type FakeAsset = string | { readonly body: string; readonly contentType: string }

export const createFakeAssets = (files: Readonly<Record<string, FakeAsset>> = {}): AssetFetcher => ({
  fetch: async (request: Request) => {
    const file = files[new URL(request.url).pathname]
    if (file === undefined) return new Response(null, { status: STATUS.notFound })
    if (typeof file === 'string') return new Response(file, { status: STATUS.ok })
    return new Response(file.body, { status: STATUS.ok, headers: { 'Content-Type': file.contentType } })
  },
})
