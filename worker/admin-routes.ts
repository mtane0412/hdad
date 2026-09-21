/**
 * 管理用の経路（/api/admin/*）
 *
 * 配信者のセッションが必要。アラートの設定の取得と保存、素材の一覧・アップロード・削除、オーバーレイ用キーの再発行を受け持つ。
 */
import { loadAlertConfig, parseAlertConfig, saveAlertConfig } from './alert-config'
import { HttpError, STATUS, requireAdmin, type Context } from './http'
import { listMedia, uploadMedia } from './media'
import { rotateOverlayKey } from './overlay-key'

/** GET /api/admin/config */
export const getConfig = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json(await loadAlertConfig(context.env.STORE))
}

/**
 * PUT /api/admin/config: 設定を検証して保存する。
 *
 * @throws ConfigError 設定に問題がある場合（index.ts が問題点付きの400にする）
 */
export const putConfig = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { request, env } = context
  const body: unknown = await request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })

  const kinds = new Map((await listMedia(env.MEDIA)).map((item) => [item.id, item.kind]))
  const config = parseAlertConfig(body, (mediaId) => kinds.get(mediaId) ?? null)
  await saveAlertConfig(env.STORE, config)
  return Response.json(config)
}

/** GET /api/admin/media */
export const getMedia = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json({ media: await listMedia(context.env.MEDIA) })
}

/** POST /api/admin/media */
export const postMedia = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json(await uploadMedia(context.env.MEDIA, context.request), { status: STATUS.created })
}

/** DELETE /api/admin/media/:id: トリガーに使われている素材は消させない（配信中にアラートが出なくなるのを防ぐ） */
export const deleteMedia = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { env, params } = context
  const id = params.id ?? ''

  if ((await env.MEDIA.head(id)) === null) throw new HttpError(STATUS.notFound, 'media-not-found', `素材「${id}」が存在しません`)
  const { triggers } = await loadAlertConfig(env.STORE)
  if (triggers.some((trigger) => trigger.mediaId === id)) {
    throw new HttpError(STATUS.conflict, 'media-in-use', 'この素材はトリガーに使われています。先にトリガーの設定から外してください')
  }

  await env.MEDIA.delete(id)
  return new Response(null, { status: STATUS.noContent })
}

/** POST /api/admin/overlay-key: オーバーレイ用キーを発行し直す */
export const postOverlayKey = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json({ overlayKey: await rotateOverlayKey(context.env.STORE) })
}
