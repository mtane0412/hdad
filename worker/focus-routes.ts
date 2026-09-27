/**
 * 注目コメントの経路（/api/admin/focus）
 *
 * 配信者が「いま取り上げているもの」を決める画面（/focus/）から呼ばれる。取り上げ方は2通りあり、
 * どちらも同じ保存先（KV。worker/focus-config.ts）で表す。
 * - 人に追従する: ログイン名だけを保存し、オーバーレイがIRCで届く発言を絞って最新の1件を映す
 * - 発言1件を取り上げる: 直近の発言から選んだ1件の中身を保存し、次の発言では差し替わらない
 *
 * 選ぶための一覧（GET /api/admin/focus/messages）は、配信中のあいだだけ貯めている発言の記録
 * （stream_chat_messages）から読む。オーバーレイ側の読み出しは overlay-routes.ts にある
 * （守り方がセッションではなくオーバーレイ用キーなので、置き場所も分けてある）。
 *
 * 注意: 値の検証は worker/focus-config.ts だけが持つ（画面とWorkerで二重に持たない。speech-config.ts と同じ）。
 */
import { loadFocusTarget, parseFocusTarget, saveFocusTarget } from './focus-config'
import { HttpError, STATUS, requireAdmin, type Context } from './http'
import { readRecentChatToPick } from './stream-chat-store'

/**
 * 取り上げる発言を選ぶ一覧に出す件数。
 *
 * 配信者が「さっきの発言」を見つけられれば足りるので、遡れる件数はこれで区切る
 * （D1の rows read を食わないためと、画面を長くしすぎないため）。
 */
export const PICK_LIMIT = 50

/** GET /api/admin/focus: いま取り上げているもの。取り上げていなければ target は null */
export const getFocus = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json({ target: await loadFocusTarget(context.env.STORE) })
}

/**
 * PUT /api/admin/focus: 取り上げるものを検証して保存する（外すときは target に null を送る）。
 *
 * @throws ConfigError 設定に問題がある場合（index.ts が問題点付きの400にする）
 */
export const putFocus = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body: unknown = await context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const target = parseFocusTarget(body)
  await saveFocusTarget(context.env.STORE, target)
  return Response.json({ target })
}

/**
 * GET /api/admin/focus/messages: 取り上げる発言を選ぶための、いま進んでいる配信の直近の発言。
 *
 * 配信していない・まだ発言が無いときは失敗にせず、空の一覧を返す（配信中のあいだだけ本文を貯めているため）。
 */
export const getFocusMessages = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json({ messages: await readRecentChatToPick(context.env.DB, PICK_LIMIT) })
}
