/**
 * 配信の記録の読み出し用の経路（/api/admin/stats/*）
 *
 * 配信者のセッションが必要。cron（collect.ts）が貯めた記録を、ダッシュボードのために返す。
 */
import { HttpError, STATUS, requireAdmin, type Context } from './http'
import { getSession, listFailures, listFollowerSamples, listSessions } from './stats-store'

/** GET /api/admin/stats/sessions: 配信セッションの一覧（新しい順。平均・最大視聴者数、フォロワー増減、イベント件数つき） */
export const getStatsSessions = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json({ sessions: await listSessions(context.env.DB, context.now) })
}

/** GET /api/admin/stats/sessions/:id: 配信セッションと視聴者数の時系列 */
export const getStatsSession = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const id = context.params.id ?? ''
  const session = await getSession(context.env.DB, id)
  if (!session) throw new HttpError(STATUS.notFound, 'session-not-found', `配信「${id}」の記録が存在しません`)
  return Response.json(session)
}

/** GET /api/admin/stats/followers: フォロワー数の時系列（値が変わった時点だけが並ぶ） */
export const getStatsFollowers = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json({ samples: await listFollowerSamples(context.env.DB) })
}

/** GET /api/admin/stats/failures: 収集の失敗の一覧（新しい順）。記録が止まっている理由を確かめるのに使う */
export const getStatsFailures = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json({ failures: await listFailures(context.env.DB) })
}
