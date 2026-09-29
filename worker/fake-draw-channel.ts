/**
 * テスト用の手書きの線の中継先
 *
 * Durable Object の代わりに、引き渡された接続を配列へ貯める。WebSocketでない呼び出し（背景の1枚の読み書き）は、
 * 本物の DrawChannel に Map の storage を持たせて処理させる。Worker のテストだけが使う
 * （プロダクションコードからは参照しない）。
 */
import { DrawChannel, type DrawChannelNamespace } from './draw-channel'
import { createFakeBackgroundStorage } from './fake-background-storage'
import { STATUS } from './http'

/** 引き渡された接続を直接確かめられるよう、記録も一緒に返す */
export const createFakeDrawChannel = (): {
  namespace: DrawChannelNamespace
  /** WebSocketの接続として引き渡されたリクエスト */
  引き渡された接続: Request[]
} => {
  const 引き渡された接続: Request[] = []
  // 背景の読み書きだけを処理させるので、接続の保持の仕組みは使わない（呼ばれたらテストの作りを疑う）
  const 使わない = (): never => {
    throw new Error('テスト用の中継先では、接続の保持の仕組みを使いません')
  }
  const channel = new DrawChannel({
    acceptWebSocket: 使わない,
    getWebSockets: 使わない,
    getTags: 使わない,
    setWebSocketAutoResponse: 使わない,
    storage: createFakeBackgroundStorage(),
  })
  const id: DurableObjectId = { toString: () => 'draw', equals: (other) => other.toString() === 'draw', name: 'draw' }

  return {
    引き渡された接続,
    namespace: {
      idFromName: () => id,
      get: () => ({
        fetch: async (request: Request) => {
          if (request.headers.get('Upgrade') !== 'websocket') return channel.fetch(request)
          // WebSocketの接続（101）はテストの環境では作れないので、引き渡されたことだけを記録して200を返す
          引き渡された接続.push(request)
          return new Response(null, { status: STATUS.ok })
        },
      }),
    },
  }
}
