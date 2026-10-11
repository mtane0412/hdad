/**
 * ペロペロの経路（issue #338）
 *
 * - GET /api/overlay/lick/socket?key=: 合成ページの素材「ペロペロ」の WebSocket の接続を配送先（AlertChannel）へ引き渡す
 * - POST /api/admin/lick/demo: 管理画面の試し再生。舐める相手をペロペロへ押し出す（トリガーと同じ配送の経路を通す）。
 *   本文の userName に相手のログイン名を入れると、その人のアイコンを舐める。省けばアイコンの無い試しの相手を舐める
 *
 * トリガーでの押し出しは alert-actions.ts が行う。どちらも Worker は舐め方の種と相手の名前・アイコンを押し出すだけで、
 * 舐め方の中身は合成ページが種から計算する（worker/lick-call.ts）。
 *
 * 注意: 配送先の失敗は、黙って成功にせず 502 で返す（管理画面に理由を出す）。相手のログイン名の打ち間違いは 400・404 で返す（worker/demo-user.ts）。
 */
import { connectLickSocket, pushLick } from './alert-channel'
import { readDemoUser } from './demo-user'
import { HttpError, STATUS, requireAdmin, requireOverlayKey, type Context } from './http'
import { demoLickCallOf, lickSeedOf } from './lick-call'
import { overlayKeyTag } from './overlay-key'

/** GET /api/overlay/lick/socket?key=: 合成ページからのWebSocketの接続を、ペロペロの呼び出しを受け取る接続として配送先へ引き渡す */
export const lickSocket = async (context: Context): Promise<Response> => {
  const key = await requireOverlayKey(context)
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectLickSocket(context.env.ALERTS, context.request, await overlayKeyTag(key))
}

/**
 * POST /api/admin/lick/demo: 管理画面の試し再生。相手を舐める呼び出しを素材へ押し出す。
 * 相手は本文の userName のログイン名の人で、省けば試しの相手（アイコンなし）にする。
 *
 * トリガーと同じ配送の経路（AlertChannel）を通すので、合成ページを開いていれば OBS の画面にもそのまま流れる。
 * 何を押し出したかを画面に出せるよう、押し出したものを返す。
 */
export const postLickDemo = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const target = await readDemoUser(context)
  const call = demoLickCallOf(target, lickSeedOf(crypto.getRandomValues(new Uint32Array(1))), crypto.randomUUID())
  try {
    await pushLick(context.env.ALERTS, call)
  } catch (error) {
    throw new HttpError(STATUS.badGateway, 'lick-push-failed', error instanceof Error ? error.message : String(error))
  }
  return Response.json(call)
}
