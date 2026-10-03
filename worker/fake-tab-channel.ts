/**
 * テスト用のタブの映像の連絡の中継先
 *
 * Durable Object の代わりに、引き渡された接続を配列へ貯める。Worker のテストだけが使う
 * （プロダクションコードからは参照しない）。
 */
import type { TabChannelNamespace } from './tab-channel'
import { STATUS } from './http'

/** 引き渡された接続を直接確かめられるよう、記録も一緒に返す */
export const createFakeTabChannel = (): {
  namespace: TabChannelNamespace
  /** WebSocketの接続として引き渡されたリクエスト */
  forwardedConnections: Request[]
  /** 合成ページの接続を閉じるよう頼まれた回数（オーバーレイ用キーの再発行） */
  readonly revocations: number
} => {
  const handedOverConnections: Request[] = []
  let revoked = 0
  const id: DurableObjectId = { toString: () => 'tab', equals: (other) => other.toString() === 'tab', name: 'tab' }

  return {
    forwardedConnections: handedOverConnections,
    get revocations() {
      return revoked
    },
    namespace: {
      idFromName: () => id,
      get: () => ({
        fetch: async (request: Request) => {
          if (new URL(request.url).pathname === '/revoke') {
            revoked += 1
            return new Response(null, { status: STATUS.noContent })
          }
          // WebSocketの接続（101）はテストの環境では作れないので、引き渡されたことだけを記録して200を返す
          handedOverConnections.push(request)
          return new Response(null, { status: STATUS.ok })
        },
      }),
    },
  }
}
