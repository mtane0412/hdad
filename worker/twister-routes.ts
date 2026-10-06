/**
 * ツイスターの経路（issue #272）
 *
 * - GET /api/overlay/twister/socket?key=: 合成ページの素材「ツイスター」の WebSocket の接続を配送先（AlertChannel）へ引き渡す
 * - POST /api/admin/twister/demo: 管理画面の試し再生。試しの相手と配信者の対戦を素材へ押し出す（トリガーと同じ配送の経路を通す）
 *
 * レイドでの押し出しは alert-actions.ts が行う。どちらも Worker は対戦の種と2人の名前・アイコンを押し出すだけで、
 * 対戦の中身は合成ページが種から計算する（worker/twister-call.ts）。
 *
 * 注意: 配信者のアイコンを引けない・配送先の失敗は、黙って成功にせず 502 で返す（管理画面に理由を出す）。
 */
import { connectTwisterSocket, pushTwister } from './alert-channel'
import { HttpError, STATUS, requireAdmin, requireOverlayKey, type Context } from './http'
import { overlayKeyTag } from './overlay-key'
import { demoTwisterCallOf, twisterSeedOf } from './twister-call'

/** GET /api/overlay/twister/socket?key=: 合成ページからのWebSocketの接続を、ツイスターの呼び出しを受け取る接続として配送先へ引き渡す */
export const twisterSocket = async (context: Context): Promise<Response> => {
  const key = await requireOverlayKey(context)
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectTwisterSocket(context.env.ALERTS, context.request, await overlayKeyTag(key))
}

/**
 * POST /api/admin/twister/demo: 管理画面の試し再生。試しの相手（アイコンなし）と、自分のアイコンの配信者の対戦を素材へ押し出す。
 *
 * トリガーと同じ配送の経路（AlertChannel）を通すので、合成ページを開いていれば OBS の画面にもそのまま流れる。
 * 何を押し出したかを画面に出せるよう、押し出したものを返す。
 */
export const postTwisterDemo = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { env, twitch } = context
  const icons = await (async (): Promise<Readonly<Record<string, string>>> => {
    try {
      return await twitch.getProfileImageUrls(await twitch.getAppAccessToken(), [env.TWITCH_BROADCASTER_ID])
    } catch (error) {
      throw new HttpError(STATUS.badGateway, 'twister-icon-failed', `配信者のアイコンを Twitch から引けませんでした: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()
  const call = demoTwisterCallOf(icons[env.TWITCH_BROADCASTER_ID] ?? null, twisterSeedOf(crypto.getRandomValues(new Uint32Array(1))), crypto.randomUUID())
  try {
    await pushTwister(env.ALERTS, call)
  } catch (error) {
    throw new HttpError(STATUS.badGateway, 'twister-push-failed', error instanceof Error ? error.message : String(error))
  }
  return Response.json(call)
}
