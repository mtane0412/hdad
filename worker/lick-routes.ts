/**
 * ペロペロの経路（issue #338）
 *
 * - GET /api/overlay/lick/socket?key=: 合成ページの素材「ペロペロ」の WebSocket の接続を配送先（AlertChannel）へ引き渡す
 * - POST /api/admin/lick/demo: 管理画面の試し再生。舐める相手をペロペロへ押し出す（トリガーと同じ配送の経路を通す）。
 *   本文の userName に相手のログイン名を入れると、その人のアイコンを舐める。省けばアイコンの無い試しの相手を舐める。効果音はトリガーと同じ設定で鳴らす
 * - GET /api/admin/lick/sound: 舌が触れるたびに鳴らす効果音の設定。未保存なら鳴らさない設定（issue #340）
 * - PUT /api/admin/lick/sound: 効果音の設定を検証して保存する（問題があれば index.ts が問題点付きの400にする）
 *
 * トリガーでの押し出しは alert-actions.ts が行う。どちらも Worker は舐め方の種と相手の名前・アイコンを押し出すだけで、
 * 舐め方の中身は合成ページが種から計算する（worker/lick-call.ts）。
 *
 * 注意: 効果音を選んでいるのにオーバーレイ用キーが未発行なら、黙って無音で流さずに 409 で返す。
 * 注意: 配送先の失敗は、黙って成功にせず 502 で返す（管理画面に理由を出す）。相手のログイン名の打ち間違いは 400・404 で返す（worker/demo-user.ts）。
 */
import { connectLickSocket, pushLick } from './alert-channel'
import { readDemoUser } from './demo-user'
import { HttpError, STATUS, requireAdmin, requireOverlayKey, type Context } from './http'
import { demoLickCallOf, lickSeedOf } from './lick-call'
import { listMedia } from './media'
import { loadLickSound, parseLickSound, playbackLickSoundOf, saveLickSound } from './lick-sound'
import { loadOverlayKey, overlayKeyTag } from './overlay-key'

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
  const [sound, overlayKey] = await Promise.all([loadLickSound(context.env.STORE), loadOverlayKey(context.env.STORE)])
  const playbackSound = ((): ReturnType<typeof playbackLickSoundOf> => {
    try {
      return playbackLickSoundOf(sound, overlayKey)
    } catch (error) {
      throw new HttpError(STATUS.conflict, 'overlay-key-missing', error instanceof Error ? error.message : String(error))
    }
  })()
  const call = demoLickCallOf(target, playbackSound, lickSeedOf(crypto.getRandomValues(new Uint32Array(1))), crypto.randomUUID())
  try {
    await pushLick(context.env.ALERTS, call)
  } catch (error) {
    throw new HttpError(STATUS.badGateway, 'lick-push-failed', error instanceof Error ? error.message : String(error))
  }
  return Response.json(call)
}

/** GET /api/admin/lick/sound: 舌が触れるたびに鳴らす効果音の設定。未保存なら鳴らさない設定が返る */
export const getLickSound = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json(await loadLickSound(context.env.STORE))
}

/**
 * PUT /api/admin/lick/sound: 効果音の設定を検証して保存し、保存したものを返す。
 *
 * @throws ConfigError 設定に問題がある場合（index.ts が問題点付きの400にする）
 */
export const putLickSound = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { request, env } = context
  const body: unknown = await request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const kinds = new Map((await listMedia(env.MEDIA)).map((item) => [item.id, item.kind]))
  const sound = parseLickSound(body, (mediaId) => kinds.get(mediaId) ?? null)
  await saveLickSound(env.STORE, sound)
  return Response.json(sound)
}
