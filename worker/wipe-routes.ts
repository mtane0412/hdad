/**
 * ワイプの経路（/api/overlay/wipe/icon）
 *
 * 合成ページの素材「ワイプ」は、チャットの発言1件ごとに、発言した人の Twitch のアイコンをワイプの枠に映す。
 * チャットは匿名IRCで受けるのでアイコンのURLが届かず、Twitch API にはトークンが要るため、ここで引いて返す。
 *
 * 注意: アイコンを引けなければ空のURLで済ませず、502にする（Fail-Fast。index.ts が TwitchApiError を502にする）。
 * 合成ページはその1件だけを飛ばし、失敗を素材の箱に出す。
 * 注意: 同じ人のアイコンは合成ページが覚えておくので、ここは呼ばれるたびに Twitch へ問い合わせる（KVに貯めない）。
 */
import { HttpError, STATUS, requireOverlayKey, type Context } from './http'

/** Twitch のログイン名の書式。合わなければ Twitch に問い合わせずに断る */
const LOGIN_PATTERN = /^[A-Za-z0-9_]{1,25}$/

/**
 * GET /api/overlay/wipe/icon?login=…: 発言した人のアイコンのURLを返す。
 *
 * @throws HttpError ログイン名が無い・書式が違う場合（400）
 * @throws TwitchApiError アイコンを引けなかった場合（index.ts が502にする）
 */
export const getWipeIcon = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  const login = context.url.searchParams.get('login')
  if (login === null || !LOGIN_PATTERN.test(login)) {
    throw new HttpError(STATUS.badRequest, 'invalid-login', 'login には Twitch のログイン名（英数字と下線、25文字まで）を指定してください')
  }
  const { twitch } = context
  return Response.json({ profileImageUrl: await twitch.getProfileImageUrl(await twitch.getAppAccessToken(), login) })
}
