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
} => {
  const handedOverConnections: Request[] = []
  const id: DurableObjectId = { toString: () => 'tab', equals: (other) => other.toString() === 'tab', name: 'tab' }

  return {
    forwardedConnections: handedOverConnections,
    namespace: {
      idFromName: () => id,
      get: () => ({
        fetch: async (request: Request) => {
          // WebSocketの接続（101）はテストの環境では作れないので、引き渡されたことだけを記録して200を返す
          handedOverConnections.push(request)
          return new Response(null, { status: STATUS.ok })
        },
      }),
    },
  }
}
