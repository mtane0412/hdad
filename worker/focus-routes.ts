/**
 * 注目コメントの経路（/api/admin/focus）
 *
 * 配信者が「いま取り上げている発言1件」を決める画面（コメントの画面 /comments/）から呼ばれる。選んだ1件に、
 * 発言した人のアイコンを Twitch から引いて添え、KV（worker/focus-config.ts）に保存する。
 *
 * オーバーレイ側の読み出しは overlay-routes.ts にある
 * （守り方がセッションではなくオーバーレイ用キーなので、置き場所も分けてある）。
 *
 * 注意: 値の検証は worker/focus-config.ts だけが持つ（画面とWorkerで二重に持たない。speech-config.ts と同じ）。
 */
import { loadFocusTarget, parseFocusPick, saveFocusTarget, type FocusTarget } from './focus-config'
import { HttpError, STATUS, requireAdmin, type Context } from './http'

/** GET /api/admin/focus: いま取り上げているもの。取り上げていなければ target は null */
export const getFocus = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json({ target: await loadFocusTarget(context.env.STORE) })
}

/**
 * PUT /api/admin/focus: 取り上げる発言を検証し、アイコンを添えて保存する（外すときは target に null を送る）。
 *
 * 注意: アイコンを引けなければ保存しない。名前を変えた・消えた人の発言は、アイコンの欠けた箱として
 * 映すより、画面で失敗を知らせて選び直してもらうほうがよい（Fail-Fast）。
 *
 * @throws ConfigError 設定に問題がある場合（index.ts が問題点付きの400にする）
 * @throws TwitchApiError アイコンを引けなかった場合（index.ts が502にする）
 */
export const putFocus = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body: unknown = await context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const pick = parseFocusPick(body)
  const { twitch } = context
  const target: FocusTarget | null =
    pick === null ? null : { ...pick, profileImageUrl: await twitch.getProfileImageUrl(await twitch.getAppAccessToken(), pick.login) }
  await saveFocusTarget(context.env.STORE, target)
  return Response.json({ target })
}

