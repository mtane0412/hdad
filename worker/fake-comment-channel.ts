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
  shouldFail?: boolean
}

/** 押し出された1件・引き渡された接続を直接確かめられるよう、記録も一緒に返す */
export const createFakeCommentChannel = ({ shouldFail = false }: FakeCommentChannelOptions = {}): {
  namespace: CommentChannelNamespace
  pushedItems: FeedItem[]
  /** WebSocketの接続として引き渡されたリクエスト */
  forwardedConnections: Request[]
} => {
  const evictedItem: FeedItem[] = []
  const handedOverConnections: Request[] = []
  const id: DurableObjectId = { toString: () => 'comments', equals: (other) => other.toString() === 'comments', name: 'comments' }

  return {
    pushedItems: evictedItem,
    forwardedConnections: handedOverConnections,
    namespace: {
      idFromName: () => id,
      get: () => ({
        fetch: async (request: Request) => {
          if (shouldFail) return new Response(null, { status: STATUS.internalServerError })
          // WebSocketの接続（101）はテストの環境では作れないので、引き渡されたことだけを記録して200を返す
          if (request.headers.get('Upgrade') === 'websocket') {
            handedOverConnections.push(request)
            return new Response(null, { status: STATUS.ok })
          }
          evictedItem.push((await request.json()) as FeedItem)
          return new Response(null, { status: STATUS.noContent })
        },
      }),
    },
  }
}
