/**
 * Twitchログインの経路（/api/auth/* と /api/me）
 *
 * 認可コードフローでTwitchにログインし、トークンを役割ごとに保管する。役割は2つある。
 * - broadcaster（既定）: 配信者本人のログイン。環境変数で指定したユーザーID以外は拒否し、セッションを開始して
 *   配信の記録のためのWebhook宛てのEventSub購読を揃える（eventsub-webhook.ts）
 * - bot: チャットを読み書きするアカウントの接続。配信者とは別のアカウントが前提なのでユーザーIDは問わず、
 *   そのぶん**配信者のセッションがある人しか開始・完了できない**ようにする（誰でもbotを差し替えられないようにするため）
 *
 * 注意: 役割はクエリではなく state（クッキーと突き合わせる値）に載せて認可画面の往復を渡す。
 * クエリだけで運ぶと、戻ってきた時点で役割を書き換えられてしまうため。
 */
import { BOT_SCOPES, REQUIRED_SCOPES } from './eventsub'
import { ensureWebhookSubscriptions } from './eventsub-webhook'
import { HttpError, SESSION_COOKIE, STATUS, readCookie, requireSession, setCookie, type Context } from './http'
import { ensureOverlayKey, loadOverlayKey } from './overlay-key'
import { randomToken, timingSafeEqual } from './secret'
import { SESSION_TTL_SECONDS, createSessionToken } from './session'
import { recordFailure } from './stats-store'
import { AuthError, loadToken, saveToken, type TokenRole } from './token'
import { TwitchApiError } from './twitch'
import { WEBHOOK_PATH } from './webhook-routes'

const STATE_COOKIE = '__Host-oauth-state'
/** Twitchの認可画面から戻ってくるまでの猶予（秒） */
const STATE_TTL_SECONDS = 10 * 60
/** ログインを終えた配信者を送る先（ダッシュボード） */
const HOME_PATH = '/'
/** botの接続を終えた配信者を送る先（管理画面のチャットボットのページ） */
const BOT_PATH = '/bot/'
export const CALLBACK_PATH = '/api/auth/callback'
const MILLISECONDS_PER_SECOND = 1000
/** state の中で、役割とランダムな値を区切る文字（ランダムな値には現れない） */
const STATE_SEPARATOR = '.'

/** 役割ごとの、認可画面で要求するスコープと、終わった後に送る先 */
const ROLES: Record<TokenRole, { scopes: readonly string[]; returnPath: string }> = {
  broadcaster: { scopes: REQUIRED_SCOPES, returnPath: HOME_PATH },
  bot: { scopes: BOT_SCOPES, returnPath: BOT_PATH },
}

const isTokenRole = (value: string): value is TokenRole => value in ROLES

/** クエリの ?role= を読む。省略時は配信者のログイン */
const readRole = (url: URL): TokenRole => {
  const role = url.searchParams.get('role')
  if (role === null) return 'broadcaster'
  if (!isTokenRole(role)) throw new HttpError(STATUS.badRequest, 'invalid-role', `${role} というログインの役割はありません`)
  return role
}

/** state から役割を取り出す。役割の部分が壊れていれば、ログインのやり直しを促す */
const roleFromState = (state: string): TokenRole => {
  const role = state.slice(0, state.indexOf(STATE_SEPARATOR))
  if (!isTokenRole(role)) {
    throw new HttpError(STATUS.badRequest, 'invalid-state', 'ログインの手順が正しくありません。/api/auth/login からやり直してください')
  }
  return role
}

export const login = async (context: Context): Promise<Response> => {
  const { url, twitch } = context
  const role = readRole(url)
  // botの接続は、配信者本人しか始められないようにする（Twitchの認可画面まで進ませない）
  if (role === 'bot') await requireSession(context)

  const state = `${role}${STATE_SEPARATOR}${randomToken()}`
  return new Response(null, {
    status: STATUS.found,
    headers: {
      Location: twitch.authorizeUrl(`${url.origin}${CALLBACK_PATH}`, state, ROLES[role].scopes),
      'Set-Cookie': setCookie(STATE_COOKIE, state, STATE_TTL_SECONDS),
    },
  })
}

/**
 * 配信の記録のためのWebhook宛ての購読を揃える。配信者がスコープを認可した直後（ログイン時）に行う。
 *
 * 注意: Twitchが失敗を返してもログインは止めない。ログインできないと、失敗の記録（/api/admin/stats/failures）を読む手段もなくなるため。
 * 黙って進むのではなく、収集の失敗として記録に残す。
 */
const prepareWebhookSubscriptions = async ({ url, env, twitch, now }: Pick<Context, 'url' | 'env' | 'twitch' | 'now'>): Promise<void> => {
  // Twitchは https のURLしかWebhookの宛先として受け付けない。ローカルの開発サーバー（http://localhost）では登録しない
  if (url.protocol !== 'https:') return
  try {
    await ensureWebhookSubscriptions({
      twitch,
      broadcasterId: env.TWITCH_BROADCASTER_ID,
      callbackUrl: `${url.origin}${WEBHOOK_PATH}`,
      secret: env.EVENTSUB_SECRET,
    })
  } catch (error) {
    if (!(error instanceof TwitchApiError)) throw error
    await recordFailure(env.DB, 'webhook-subscription-failed', error.message, now)
  }
}

export const callback = async (context: Context): Promise<Response> => {
  const { request, url, env, twitch, now } = context
  const denied = url.searchParams.get('error')
  if (denied) throw new HttpError(STATUS.badRequest, 'authorization-denied', `Twitchでの認可が完了しませんでした（${denied}）`)

  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const expectedState = readCookie(request, STATE_COOKIE)
  if (!code || !state || !expectedState || !timingSafeEqual(state, expectedState)) {
    throw new HttpError(STATUS.badRequest, 'invalid-state', 'ログインの手順が正しくありません。/api/auth/login からやり直してください')
  }

  const role = roleFromState(state)
  // botの接続は、配信者本人しか完了できないようにする（認可画面にいる間にログアウトした場合もここで止まる）
  if (role === 'bot') await requireSession(context)

  const grant = await twitch.exchangeCode(code, `${url.origin}${CALLBACK_PATH}`)
  const owner = await twitch.validate(grant.accessToken)
  // 配信者のログインだけは本人確認する。botは別アカウントが前提なのでユーザーIDを問わない
  if (role === 'broadcaster' && owner.userId !== env.TWITCH_BROADCASTER_ID) {
    throw new HttpError(STATUS.forbidden, 'not-broadcaster', `このTwitchアカウント（${owner.login}）ではログインできません`)
  }

  await saveToken(env.STORE, role, {
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    expiresAt: now + grant.expiresIn * MILLISECONDS_PER_SECOND,
    ...owner,
  })

  const headers = new Headers({ Location: ROLES[role].returnPath })
  if (role === 'broadcaster') {
    await ensureOverlayKey(env.STORE)
    await prepareWebhookSubscriptions({ url, env, twitch, now })
    headers.append('Set-Cookie', setCookie(SESSION_COOKIE, await createSessionToken(owner.userId, env.SESSION_SECRET, now), SESSION_TTL_SECONDS))
  }
  headers.append('Set-Cookie', setCookie(STATE_COOKIE, '', 0))
  return new Response(null, { status: STATUS.found, headers })
}

export const logout = (): Response =>
  new Response(null, { status: STATUS.noContent, headers: { 'Set-Cookie': setCookie(SESSION_COOKIE, '', 0) } })

export const me = async (context: Context): Promise<Response> => {
  await requireSession(context)
  const token = await loadToken(context.env.STORE, 'broadcaster')
  if (!token) throw new AuthError('not-logged-in', 'Twitchのトークンが保存されていません。ログインし直してください')
  return Response.json({ userId: token.userId, login: token.login, overlayKey: await loadOverlayKey(context.env.STORE) })
}
