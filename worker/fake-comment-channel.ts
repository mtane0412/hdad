/**
 * テスト用のコメントビューアーの配送先
 *
 * Durable Object の代わりに、押し出された1件を配列へ貯める。Worker のテストだけが使う
 * （プロダクションコードからは参照しない）。
 */
import type { CommentChannelNamespace } from './comment-channel'
import type { FeedItem } from './comment-feed'
import { STATUS } from './http'

interface FakeCommentChannelOptions {
  /** 配送先が失敗を返す場合（押し出し側が失敗を握りつぶさないことを確かめる） */
  失敗する?: boolean
}

/** 押し出された1件・引き渡された接続を直接確かめられるよう、記録も一緒に返す */
export const createFakeCommentChannel = ({ 失敗する = false }: FakeCommentChannelOptions = {}): {
  namespace: CommentChannelNamespace
  押し出された1件: FeedItem[]
  /** WebSocketの接続として引き渡されたリクエスト */
  引き渡された接続: Request[]
} => {
  const 押し出された1件: FeedItem[] = []
  const 引き渡された接続: Request[] = []
  const id: DurableObjectId = { toString: () => 'comments', equals: (other) => other.toString() === 'comments', name: 'comments' }

  return {
    押し出された1件,
    引き渡された接続,
    namespace: {
      idFromName: () => id,
      get: () => ({
        fetch: async (request: Request) => {
          if (失敗する) return new Response(null, { status: STATUS.internalServerError })
          // WebSocketの接続（101）はテストの環境では作れないので、引き渡されたことだけを記録して200を返す
          if (request.headers.get('Upgrade') === 'websocket') {
            引き渡された接続.push(request)
            return new Response(null, { status: STATUS.ok })
          }
          押し出された1件.push((await request.json()) as FeedItem)
          return new Response(null, { status: STATUS.noContent })
        },
      }),
    },
  }
}
