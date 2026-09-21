/**
 * Twitchログインの経路（/api/auth/* と /api/me）
 *
 * 認可コードフローでTwitchにログインし、配信者本人ならトークンを保管してセッションを開始する。
 * 環境変数で指定した配信者のユーザーID以外のアカウントは拒否する。
 */
import { REQUIRED_SCOPES } from './eventsub'
import { HttpError, SESSION_COOKIE, STATUS, readCookie, requireSession, setCookie, type Context } from './http'
import { ensureOverlayKey, loadOverlayKey } from './overlay-key'
import { randomToken, timingSafeEqual } from './secret'
import { SESSION_TTL_SECONDS, createSessionToken } from './session'
import { AuthError, loadToken, saveToken } from './token'

const STATE_COOKIE = '__Host-oauth-state'
/** Twitchの認可画面から戻ってくるまでの猶予（秒） */
const STATE_TTL_SECONDS = 10 * 60
/** ログインを終えた配信者を送る先（ダッシュボード） */
const HOME_PATH = '/'
export const CALLBACK_PATH = '/api/auth/callback'
const MILLISECONDS_PER_SECOND = 1000

export const login = ({ url, twitch }: Context): Response => {
  const state = randomToken()
  return new Response(null, {
    status: STATUS.found,
    headers: {
      Location: twitch.authorizeUrl(`${url.origin}${CALLBACK_PATH}`, state, REQUIRED_SCOPES),
      'Set-Cookie': setCookie(STATE_COOKIE, state, STATE_TTL_SECONDS),
    },
  })
}

export const callback = async ({ request, url, env, twitch, now }: Context): Promise<Response> => {
  const denied = url.searchParams.get('error')
  if (denied) throw new HttpError(STATUS.badRequest, 'authorization-denied', `Twitchでの認可が完了しませんでした（${denied}）`)

  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const expectedState = readCookie(request, STATE_COOKIE)
  if (!code || !state || !expectedState || !timingSafeEqual(state, expectedState)) {
    throw new HttpError(STATUS.badRequest, 'invalid-state', 'ログインの手順が正しくありません。/api/auth/login からやり直してください')
  }

  const grant = await twitch.exchangeCode(code, `${url.origin}${CALLBACK_PATH}`)
  const owner = await twitch.validate(grant.accessToken)
  if (owner.userId !== env.TWITCH_BROADCASTER_ID) {
    throw new HttpError(STATUS.forbidden, 'not-broadcaster', `このTwitchアカウント（${owner.login}）ではログインできません`)
  }

  await saveToken(env.STORE, {
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    expiresAt: now + grant.expiresIn * MILLISECONDS_PER_SECOND,
    ...owner,
  })
  await ensureOverlayKey(env.STORE)

  const headers = new Headers({ Location: HOME_PATH })
  headers.append('Set-Cookie', setCookie(SESSION_COOKIE, await createSessionToken(owner.userId, env.SESSION_SECRET, now), SESSION_TTL_SECONDS))
  headers.append('Set-Cookie', setCookie(STATE_COOKIE, '', 0))
  return new Response(null, { status: STATUS.found, headers })
}

export const logout = (): Response =>
  new Response(null, { status: STATUS.noContent, headers: { 'Set-Cookie': setCookie(SESSION_COOKIE, '', 0) } })

export const me = async (context: Context): Promise<Response> => {
  await requireSession(context)
  const token = await loadToken(context.env.STORE)
  if (!token) throw new AuthError('not-logged-in', 'Twitchのトークンが保存されていません。ログインし直してください')
  return Response.json({ userId: token.userId, login: token.login, overlayKey: await loadOverlayKey(context.env.STORE) })
}
