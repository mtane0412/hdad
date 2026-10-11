/**
 * ツイスターの経路（issue #272）
 *
 * - GET /api/overlay/twister/socket?key=: 合成ページの素材「ツイスター」の WebSocket の接続を配送先（AlertChannel）へ引き渡す
 * - POST /api/admin/twister/demo: 管理画面の試し再生。試しの相手と配信者の対戦を素材へ押し出す（トリガーと同じ配送の経路を通す）。
 *   本文の userName に相手のログイン名を入れると、その人がレイドしてきたものとみなして対戦する。BGM はレイドと同じ設定で流す
 * - GET /api/admin/twister/sound: 対戦のあいだ流す BGM の設定。未保存なら BGM を流さない設定
 * - PUT /api/admin/twister/sound: BGM の設定を検証して保存する（問題があれば index.ts が問題点付きの400にする）
 *
 * レイドでの押し出しは alert-actions.ts が行う。どちらも Worker は対戦の種と2人の名前・アイコンを押し出すだけで、
 * 対戦の中身は合成ページが種から計算する（worker/twister-call.ts）。
 *
 * 注意: 配信者の表示名とアイコンを引けない・配送先の失敗は、黙って成功にせず 502 で返す（管理画面に理由を出す）。
 * 注意: 相手のログイン名の打ち間違いは、試しの相手に差し替えずに 400・404 で返す。
 * 注意: BGM を選んでいるのにオーバーレイ用キーが未発行なら、黙って無音で流さずに 409 で返す。
 */
import { connectTwisterSocket, pushTwister } from './alert-channel'
import { readDemoUser } from './demo-user'
import { HttpError, STATUS, requireAdmin, requireOverlayKey, type Context } from './http'
import { listMedia } from './media'
import { loadOverlayKey, overlayKeyTag } from './overlay-key'
import { demoTwisterCallOf, twisterSeedOf, type TwisterPlayer } from './twister-call'
import { loadTwisterSound, parseTwisterSound, playbackTwisterSoundOf, saveTwisterSound } from './twister-sound'

/** GET /api/overlay/twister/socket?key=: 合成ページからのWebSocketの接続を、ツイスターの呼び出しを受け取る接続として配送先へ引き渡す */
export const twisterSocket = async (context: Context): Promise<Response> => {
  const key = await requireOverlayKey(context)
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectTwisterSocket(context.env.ALERTS, context.request, await overlayKeyTag(key))
}

/**
 * POST /api/admin/twister/demo: 管理画面の試し再生。相手と、自分の表示名とアイコンの配信者の対戦を素材へ押し出す。
 * 相手は本文の userName のログイン名の人で、省けば試しの相手（アイコンなし）にする。
 *
 * トリガーと同じ配送の経路（AlertChannel）を通すので、合成ページを開いていれば OBS の画面にもそのまま流れる。
 * 何を押し出したかを画面に出せるよう、押し出したものを返す。
 */
export const postTwisterDemo = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { env, twitch } = context
  const raider = await readDemoUser(context)
  const [sound, overlayKey] = await Promise.all([loadTwisterSound(env.STORE), loadOverlayKey(env.STORE)])
  const playbackSound = ((): ReturnType<typeof playbackTwisterSoundOf> => {
    try {
      return playbackTwisterSoundOf(sound, overlayKey)
    } catch (error) {
      throw new HttpError(STATUS.conflict, 'overlay-key-missing', error instanceof Error ? error.message : String(error))
    }
  })()
  // セッションは配信者のユーザーIDしか持たない。保管庫のトークンのログイン名は、Twitch でログイン名を変えると古くなる（別人を引きうる）ので使わず、
  // ユーザーIDからいまのログイン名を引いてから、表示名とアイコンを引く
  const broadcaster = await (async (): Promise<TwisterPlayer> => {
    try {
      const accessToken = await twitch.getAppAccessToken()
      const user = await twitch.getUserByLogin(accessToken, await twitch.getUserLogin(accessToken, env.TWITCH_BROADCASTER_ID))
      if (user === null) throw new Error(`ユーザーID ${env.TWITCH_BROADCASTER_ID} のログイン名のユーザーがいません`)
      return { name: user.displayName, iconUrl: user.profileImageUrl }
    } catch (error) {
      throw new HttpError(STATUS.badGateway, 'twister-broadcaster-failed', `配信者の表示名とアイコンを Twitch から引けませんでした: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()
  const call = demoTwisterCallOf(raider, broadcaster, playbackSound, twisterSeedOf(crypto.getRandomValues(new Uint32Array(1))), crypto.randomUUID())
  try {
    await pushTwister(env.ALERTS, call)
  } catch (error) {
    throw new HttpError(STATUS.badGateway, 'twister-push-failed', error instanceof Error ? error.message : String(error))
  }
  return Response.json(call)
}

/** GET /api/admin/twister/sound: 対戦のあいだ流す BGM の設定。未保存なら BGM を流さない設定が返る */
export const getTwisterSound = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json(await loadTwisterSound(context.env.STORE))
}

/**
 * PUT /api/admin/twister/sound: BGM の設定を検証して保存し、保存したものを返す。
 *
 * @throws ConfigError 設定に問題がある場合（index.ts が問題点付きの400にする）
 */
export const putTwisterSound = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { request, env } = context
  const body: unknown = await request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const kinds = new Map((await listMedia(env.MEDIA)).map((item) => [item.id, item.kind]))
  const sound = parseTwisterSound(body, (mediaId) => kinds.get(mediaId) ?? null)
  await saveTwisterSound(env.STORE, sound)
  return Response.json(sound)
}
