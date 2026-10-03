/**
 * 作業机の経路（合成ページの素材「作業机」から呼ばれる）
 *
 * 視聴者が !task・!done で宣言した作業を並べる素材が、オーバーレイ用キーで次の2つを使う（issue #207）。
 * - GET /api/overlay/task-desk: いまの配信の作業机を返す。開いたとき・つなぎ直したとき・定期的に読み、
 *   つながっていない間の変化と配信の切り替わり（前の配信の宣言を片付ける）を取り戻す
 * - GET /api/overlay/task-desk/socket: 作業机が変わるたびに丸ごと押し出してもらう WebSocket。接続を保持するのはアラートと同じ
 *   Durable Object（worker/alert-channel.ts）で、ここはキーを確かめて引き渡すだけである
 */
import { connectTaskDeskSocket } from './alert-channel'
import { HttpError, STATUS, requireOverlayKey, type Context } from './http'
import { overlayKeyTag } from './overlay-key'
import { TASK_DESK_LIMIT } from './task-desk'
import { readTaskDesk } from './task-desk-store'

/**
 * GET /api/overlay/task-desk?key=: いまの配信の作業机を、上限の人数まで返す。
 *
 * 配信していないときは失敗にせず空の一覧を返す（配信の前後にOBSを開いたままにするのが普通なので。作業ログと同じ）。
 */
export const getTaskDesk = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  return Response.json({ entries: await readTaskDesk(context.env.DB, context.now, TASK_DESK_LIMIT) })
}

/**
 * GET /api/overlay/task-desk/socket?key=: 合成ページからのWebSocketの接続を、作業机を受け取る接続として配送先へ引き渡す。
 */
export const taskDeskSocket = async (context: Context): Promise<Response> => {
  const key = await requireOverlayKey(context)
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectTaskDeskSocket(context.env.ALERTS, context.request, await overlayKeyTag(key))
}
