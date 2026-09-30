/**
 * テスト用の手書きの線の中継先
 *
 * Durable Object の代わりに、引き渡された接続を配列へ貯める。Worker のテストだけが使う
 * （プロダクションコードからは参照しない）。
 */
import type { DrawChannelNamespace } from './draw-channel'
import { STATUS } from './http'

/** 引き渡された接続を直接確かめられるよう、記録も一緒に返す */
export const createFakeDrawChannel = (): {
  namespace: DrawChannelNamespace
  /** WebSocketの接続として引き渡されたリクエスト */
  forwardedConnections: Request[]
} => {
  const 引き渡された接続: Request[] = []
  const id: DurableObjectId = { toString: () => 'draw', equals: (other) => other.toString() === 'draw', name: 'draw' }

  return {
    forwardedConnections: 引き渡された接続,
    namespace: {
      idFromName: () => id,
      get: () => ({
        fetch: async (request: Request) => {
          // WebSocketの接続（101）はテストの環境では作れないので、引き渡されたことだけを記録して200を返す
          引き渡された接続.push(request)
          return new Response(null, { status: STATUS.ok })
        },
      }),
    },
  }
}
