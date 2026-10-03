/**
 * テスト用のアラートの配送先
 *
 * Durable Object の代わりに、押し出されたアラートを配列へ貯める。Worker のテストだけが使う
 * （プロダクションコードからは参照しない）。
 */
import type { AlertChannelNamespace } from './alert-channel'
import type { OverlayAlert } from './alert-event'
import type { BgmNowPlaying } from './bgm-config'
import { STATUS } from './http'
import type { WorkLogEntry } from './work-log'

interface FakeAlertChannelOptions {
  /** 配送先が失敗を返す場合（押し出し側が失敗を握りつぶさないことを確かめる） */
  shouldFail?: boolean
}

/** 押し出されたアラート・引き渡された接続を直接確かめられるよう、記録も一緒に返す */
export const createFakeAlertChannel = ({ shouldFail = false }: FakeAlertChannelOptions = {}): {
  namespace: AlertChannelNamespace
  pushedAlerts: OverlayAlert[]
  /** 押し出された「いま流している曲」 */
  pushedBgm: BgmNowPlaying[]
  /** 押し出された作業ログの1行 */
  pushedWorkLog: WorkLogEntry[]
  /** WebSocketの接続として引き渡されたリクエスト */
  forwardedConnections: Request[]
  /** 接続をすべて閉じるよう頼まれたときに添えられた、新しいキーの目印（オーバーレイ用キーの再発行） */
  revokedKeyTags: string[]
} => {
  const evictedAlerts: OverlayAlert[] = []
  const evictedBgm: BgmNowPlaying[] = []
  const evictedWorkLog: WorkLogEntry[] = []
  const handedOverConnections: Request[] = []
  const revokedTags: string[] = []
  const id: DurableObjectId = { toString: () => 'alerts', equals: (other) => other.toString() === 'alerts', name: 'alerts' }

  return {
    pushedAlerts: evictedAlerts,
    pushedBgm: evictedBgm,
    pushedWorkLog: evictedWorkLog,
    forwardedConnections: handedOverConnections,
    revokedKeyTags: revokedTags,
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
          const { pathname } = new URL(request.url)
          if (pathname === '/revoke') {
            revokedTags.push(((await request.json()) as { keyTag: string }).keyTag)
            return new Response(null, { status: STATUS.noContent })
          }
          if (pathname === '/push/bgm') evictedBgm.push((await request.json()) as BgmNowPlaying)
          else if (pathname === '/push/work-log') evictedWorkLog.push((await request.json()) as WorkLogEntry)
          else evictedAlerts.push((await request.json()) as OverlayAlert)
          return new Response(null, { status: STATUS.noContent })
        },
      }),
    },
  }
}
