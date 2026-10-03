/**
 * 作業ログの経路（合成ページの素材「作業ログ」から呼ばれる）
 *
 * 作業配信に途中から来た人へ「今日ここまでにやったこと」を見せる素材が、オーバーレイ用キーで次の2つを使う（issue #211）。
 * - GET /api/overlay/work-log: いまの配信の作業ログを新しい順に返す。開いたとき・つなぎ直したとき・定期的に読み、
 *   つながっていない間に増えた行を取り戻す
 * - GET /api/overlay/work-log/socket: 増えた1行を押し出してもらう WebSocket。接続を保持するのはアラートと同じ
 *   Durable Object（worker/alert-channel.ts）で、ここはキーを確かめて引き渡すだけである
 */
import { connectWorkLogSocket } from './alert-channel'
import { HttpError, STATUS, requireOverlayKey, type Context } from './http'
import { overlayKeyTag } from './overlay-key'
import { WORK_LOG_LIMIT } from './work-log'
import { readWorkLog } from './work-log-store'

/**
 * GET /api/overlay/work-log?key=: いまの配信の作業ログ（開発の出来事と章の見出し）を、新しい順に上限まで返す。
 *
 * 配信していないときは失敗にせず空の一覧を返す（配信の前後にOBSを開いたままにするのが普通なので。サイドスーパーと同じ）。
 */
export const getWorkLog = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  return Response.json({ entries: await readWorkLog(context.env.DB, context.now, WORK_LOG_LIMIT) })
}

/**
 * GET /api/overlay/work-log/socket?key=: 合成ページからのWebSocketの接続を、作業ログの1行を受け取る接続として配送先へ引き渡す。
 */
export const workLogSocket = async (context: Context): Promise<Response> => {
  const key = await requireOverlayKey(context)
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectWorkLogSocket(context.env.ALERTS, context.request, await overlayKeyTag(key))
}
