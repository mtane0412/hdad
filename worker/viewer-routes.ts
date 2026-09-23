/**
 * 視聴者の記録の読み書き用の経路（/api/admin/viewers）
 *
 * 配信者のセッションが必要。チャットの受け口（webhook-routes.ts）が貯めた人の記録を、管理画面（/viewers/）のために
 * 読み出し、メモの書き換えと記録の削除を受け持つ。記録そのものの読み書きは viewer-store.ts にある。
 *
 * 注意: 件数が多くなるので一覧は全件を返さず、?search・?before・?limit で少しずつ読む。
 * 注意: 指定が想定と違えば、黙って既定に戻さず400にする（Fail-Fast）。
 */
import { HttpError, STATUS, requireAdmin, type Context } from './http'
import { VIEWER_LIST_MAX_LIMIT, deleteViewer, listViewers, updateViewerNote } from './viewer-store'

/** メモの長さの上限（文字数）。1人1行の記録に際限なく書き込ませないための歯止め */
const NOTE_MAX_LENGTH = 2000

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * ?limit を読む。指定がなければ undefined（viewer-store.ts の既定の件数になる）。
 *
 * @throws HttpError 数でない、または範囲の外のとき
 */
const readLimit = (raw: string | null): number | undefined => {
  if (raw === null) return undefined
  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > VIEWER_LIST_MAX_LIMIT) {
    throw new HttpError(STATUS.badRequest, 'invalid-limit', `limit は1〜${VIEWER_LIST_MAX_LIMIT}の整数にしてください`)
  }
  return limit
}

/**
 * GET /api/admin/viewers: 記録のある人を、最後に発言した順（新しい順）で返す。
 *
 * ?search はログイン名の前方一致（大文字小文字は区別しない）、?before は「この日時より前に発言した人」で、
 * 続きを読むときは一覧の最後の lastSeenAt と userId（?beforeUserId）を渡す。ユーザーIDも渡すのは、
 * 最後の発言日時が同じ人がページの境目にまたがったときに取りこぼさないためである。
 */
export const getViewers = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { url, env } = context
  const viewers = await listViewers(env.DB, {
    loginPrefix: url.searchParams.get('search') ?? '',
    before: url.searchParams.get('before') ?? '',
    beforeUserId: url.searchParams.get('beforeUserId') ?? '',
    limit: readLimit(url.searchParams.get('limit')),
  })
  return Response.json({ viewers })
}

/** PATCH /api/admin/viewers/:userId: 配信者が書くメモを保存する */
export const patchViewer = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { request, env, params } = context
  const userId = params.userId ?? ''

  const body: unknown = await request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const note: unknown = isRecord(body) ? body.note : undefined
  if (typeof note !== 'string') throw new HttpError(STATUS.badRequest, 'invalid-note', 'note は文字列にしてください')
  if (note.length > NOTE_MAX_LENGTH) {
    throw new HttpError(STATUS.badRequest, 'note-too-long', `メモは${NOTE_MAX_LENGTH}文字までにしてください`)
  }

  if (!(await updateViewerNote(env.DB, userId, note))) {
    throw new HttpError(STATUS.notFound, 'viewer-not-found', `視聴者「${userId}」の記録が存在しません`)
  }
  return Response.json({ userId, note })
}

/** DELETE /api/admin/viewers/:userId: 人ごとの記録を消す（本人から求められたときに応じるためのもの） */
export const deleteViewerRoute = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { env, params } = context
  const userId = params.userId ?? ''

  if (!(await deleteViewer(env.DB, userId))) {
    throw new HttpError(STATUS.notFound, 'viewer-not-found', `視聴者「${userId}」の記録が存在しません`)
  }
  return new Response(null, { status: STATUS.noContent })
}
