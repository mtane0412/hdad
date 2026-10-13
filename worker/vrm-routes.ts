/**
 * VRMの演出の経路（issue #358）
 *
 * - GET /api/overlay/vrm/socket?key=: 合成ページの素材「VRM」の WebSocket の接続を配送先（AlertChannel）へ引き渡す
 * - POST /api/admin/vrm/demo: 管理画面の試し再生。選んである VRM の演出を素材へ押し出す（トリガーと同じ配送の経路を通す）
 * - GET /api/admin/vrm/model: 出す VRM の設定。未保存なら選んでいない設定
 * - PUT /api/admin/vrm/model: 出す VRM の設定を検証して保存する（問題があれば index.ts が問題点付きの400にする）
 *
 * トリガーでの押し出しは alert-actions.ts が行う。どちらも Worker は動き方の種と VRM のURLを押し出すだけで、
 * 動きの中身は合成ページが種から計算する（worker/vrm-call.ts）。
 *
 * 注意: VRM を選んでいない・オーバーレイ用キーが未発行なら、黙って何も出さずに済ませず 409 で返す。
 * 注意: 配送先の失敗は、黙って成功にせず 502 で返す（管理画面に理由を出す）。
 */
import { connectVrmSocket, pushVrm } from './alert-channel'
import { HttpError, STATUS, requireAdmin, requireOverlayKey, type Context } from './http'
import { listMedia } from './media'
import { loadOverlayKey, overlayKeyTag } from './overlay-key'
import { vrmCallOf, vrmSeedOf } from './vrm-call'
import { loadVrmModel, parseVrmModel, playbackVrmModelOf, saveVrmModel } from './vrm-model'

/** GET /api/overlay/vrm/socket?key=: 合成ページからのWebSocketの接続を、VRMの演出の呼び出しを受け取る接続として配送先へ引き渡す */
export const vrmSocket = async (context: Context): Promise<Response> => {
  const key = await requireOverlayKey(context)
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectVrmSocket(context.env.ALERTS, context.request, await overlayKeyTag(key))
}

/**
 * POST /api/admin/vrm/demo: 管理画面の試し再生。選んである VRM の演出の呼び出しを素材へ押し出す。
 *
 * トリガーと同じ配送の経路（AlertChannel）を通すので、合成ページを開いていれば OBS の画面にもそのまま流れる。
 * 何を押し出したかを画面に出せるよう、押し出したものを返す。
 */
export const postVrmDemo = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const [model, overlayKey] = await Promise.all([loadVrmModel(context.env.STORE), loadOverlayKey(context.env.STORE)])
  const modelUrl = ((): string => {
    try {
      return playbackVrmModelOf(model, overlayKey)
    } catch (error) {
      throw new HttpError(STATUS.conflict, 'vrm-not-ready', error instanceof Error ? error.message : String(error))
    }
  })()
  const call = vrmCallOf(modelUrl, vrmSeedOf(crypto.getRandomValues(new Uint32Array(1))), crypto.randomUUID())
  try {
    await pushVrm(context.env.ALERTS, call)
  } catch (error) {
    throw new HttpError(STATUS.badGateway, 'vrm-push-failed', error instanceof Error ? error.message : String(error))
  }
  return Response.json(call)
}

/** GET /api/admin/vrm/model: 出す VRM の設定。未保存なら選んでいない設定が返る */
export const getVrmModel = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json(await loadVrmModel(context.env.STORE))
}

/**
 * PUT /api/admin/vrm/model: 出す VRM の設定を検証して保存し、保存したものを返す。
 *
 * @throws ConfigError 設定に問題がある場合（index.ts が問題点付きの400にする）
 */
export const putVrmModel = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { request, env } = context
  const body: unknown = await request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const kinds = new Map((await listMedia(env.MEDIA)).map((item) => [item.id, item.kind]))
  const model = parseVrmModel(body, (mediaId) => kinds.get(mediaId) ?? null)
  await saveVrmModel(env.STORE, model)
  return Response.json(model)
}
