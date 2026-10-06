/**
 * 配信タイトルの候補づくりの設定の経路（/api/admin/stream-title/settings）
 *
 * ダッシュボード（/）が、章ごとに配信タイトルの候補を作るか（試験運用。issue #268）を読み書きする。
 * 候補そのものは配信の詳細（GET /api/admin/stats/sessions/:id の titleCandidates）で読む。
 *
 * 注意: 値の検証は worker/stream-title-config.ts だけが持つ。
 */
import { HttpError, STATUS, requireAdmin, type Context } from './http'
import { loadStreamTitleSettings, parseStreamTitleSettings, saveStreamTitleSettings } from './stream-title-config'

/** 本文をJSONとして読む。読めなければ400にする */
const readJson = (context: Context): Promise<unknown> =>
  context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })

/** GET /api/admin/stream-title/settings: 候補を作るかの設定。未保存なら作らない */
export const getStreamTitleSettings = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json({ settings: await loadStreamTitleSettings(context.env.STORE) })
}

/**
 * PUT /api/admin/stream-title/settings: 候補を作るかの設定を検証して保存する。
 *
 * @throws ConfigError 設定に問題がある場合（index.ts が問題点付きの400にする）
 */
export const putStreamTitleSettings = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const settings = parseStreamTitleSettings(await readJson(context))
  await saveStreamTitleSettings(context.env.STORE, settings)
  return Response.json({ settings })
}
