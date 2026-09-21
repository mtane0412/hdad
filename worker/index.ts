/**
 * WorkerのAPI（/api/*）
 *
 * 静的アセットでは扱えない「秘密を持つ処理」だけを受け持つ。
 * - GET  /api/auth/login              Twitchの認可ページへ送る
 * - GET  /api/auth/callback           認可コードをトークンに交換し、配信者本人ならセッションを開始する
 * - POST /api/auth/logout             セッションを終える
 * - GET  /api/me                      ログイン中の配信者とオーバーレイ用キーを返す（管理画面用）
 * - POST /api/eventsub/subscriptions  オーバーレイのEventSubセッションに対して購読を代行する
 *
 * Twitchのトークンは応答に含めない。失敗は { error: { code, message } } の形で返し、黙って成功扱いにしない。
 * fetch と現在時刻を引数で受け取るのは、テストで差し替えるため。
 */
import { REQUIRED_SCOPES, subscribeAll } from './eventsub'
import { ensureOverlayKey, isValidOverlayKey, loadOverlayKey } from './overlay-key'
import { randomToken, timingSafeEqual } from './secret'
import { SESSION_TTL_SECONDS, createSessionToken, verifySessionToken } from './session'
import type { KeyValueStore } from './store'
import { AuthError, loadToken, saveToken } from './token'
import { TwitchApiError, createTwitchClient, type TwitchClient } from './twitch'

/** wrangler.jsonc のバインディングと、シークレット（.dev.vars／ダッシュボードで設定） */
export interface Env {
  STORE: KeyValueStore
  TWITCH_CLIENT_ID: string
  TWITCH_CLIENT_SECRET: string
  /** 管理画面へのログインを許す、配信者のTwitchユーザーID（数字） */
  TWITCH_BROADCASTER_ID: string
  /** セッションの署名に使うランダムな文字列 */
  SESSION_SECRET: string
}

interface Dependencies {
  fetch: typeof fetch
  /** 現在時刻（ミリ秒） */
  now(): number
}

interface Context {
  request: Request
  url: URL
  env: Env
  twitch: TwitchClient
  now: number
}

const REQUIRED_VARIABLES = ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_BROADCASTER_ID', 'SESSION_SECRET'] as const
const SESSION_COOKIE = '__Host-session'
const STATE_COOKIE = '__Host-oauth-state'
/** Twitchの認可画面から戻ってくるまでの猶予（秒） */
const STATE_TTL_SECONDS = 10 * 60
const CALLBACK_PATH = '/api/auth/callback'
const MILLISECONDS_PER_SECOND = 1000

const STATUS = {
  ok: 200,
  noContent: 204,
  found: 302,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  methodNotAllowed: 405,
  internalServerError: 500,
  badGateway: 502,
} as const

/** 決まった状態コードとエラーコードで応答させるためのエラー */
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const errorResponse = (status: number, code: string, message: string): Response =>
  Response.json({ error: { code, message } }, { status })

const setCookie = (name: string, value: string, maxAgeSeconds: number): string =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`

const readCookie = (request: Request, name: string): string | null => {
  const pairs = (request.headers.get('Cookie') ?? '').split(';').map((pair) => pair.trim())
  const found = pairs.find((pair) => pair.startsWith(`${name}=`))
  return found ? found.slice(name.length + 1) : null
}

/** 配信者本人の有効なセッションがなければ401にする */
const requireSession = async ({ request, env, now }: Context): Promise<void> => {
  const token = readCookie(request, SESSION_COOKIE)
  const userId = token ? await verifySessionToken(token, env.SESSION_SECRET, now) : null
  if (userId !== env.TWITCH_BROADCASTER_ID) {
    throw new HttpError(STATUS.unauthorized, 'unauthorized', 'ログインが必要です。/api/auth/login からログインしてください')
  }
}

const login = ({ url, twitch }: Context): Response => {
  const state = randomToken()
  return new Response(null, {
    status: STATUS.found,
    headers: {
      Location: twitch.authorizeUrl(`${url.origin}${CALLBACK_PATH}`, state, REQUIRED_SCOPES),
      'Set-Cookie': setCookie(STATE_COOKIE, state, STATE_TTL_SECONDS),
    },
  })
}

const callback = async ({ request, url, env, twitch, now }: Context): Promise<Response> => {
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

  const headers = new Headers({ Location: '/api/me' })
  headers.append('Set-Cookie', setCookie(SESSION_COOKIE, await createSessionToken(owner.userId, env.SESSION_SECRET, now), SESSION_TTL_SECONDS))
  headers.append('Set-Cookie', setCookie(STATE_COOKIE, '', 0))
  return new Response(null, { status: STATUS.found, headers })
}

const logout = (): Response =>
  new Response(null, { status: STATUS.noContent, headers: { 'Set-Cookie': setCookie(SESSION_COOKIE, '', 0) } })

const me = async (context: Context): Promise<Response> => {
  await requireSession(context)
  const token = await loadToken(context.env.STORE)
  if (!token) throw new AuthError('not-logged-in', 'Twitchのトークンが保存されていません。ログインし直してください')
  return Response.json({ userId: token.userId, login: token.login, overlayKey: await loadOverlayKey(context.env.STORE) })
}

const subscribe = async ({ request, env, twitch, now }: Context): Promise<Response> => {
  const body: unknown = await request.json().catch(() => null)
  const { key, sessionId } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (typeof key !== 'string' || typeof sessionId !== 'string' || sessionId === '') {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文は { "key": string, "sessionId": string } の形のJSONにしてください')
  }
  if (!(await isValidOverlayKey(env.STORE, key))) {
    throw new HttpError(STATUS.unauthorized, 'invalid-overlay-key', 'オーバーレイ用キーが正しくありません。管理画面のURLを貼り直してください')
  }

  const types = await subscribeAll({ store: env.STORE, twitch, broadcasterId: env.TWITCH_BROADCASTER_ID, sessionId, now })
  return Response.json({ types })
}

const ROUTES: Record<string, { method: string; handle(context: Context): Response | Promise<Response> }> = {
  '/api/auth/login': { method: 'GET', handle: login },
  [CALLBACK_PATH]: { method: 'GET', handle: callback },
  '/api/auth/logout': { method: 'POST', handle: logout },
  '/api/me': { method: 'GET', handle: me },
  '/api/eventsub/subscriptions': { method: 'POST', handle: subscribe },
}

const toErrorResponse = (error: unknown): Response => {
  if (error instanceof HttpError) return errorResponse(error.status, error.code, error.message)
  if (error instanceof AuthError) return errorResponse(STATUS.unauthorized, error.code, error.message)
  if (error instanceof TwitchApiError) return errorResponse(STATUS.badGateway, 'twitch-error', error.message)
  console.error(error)
  return errorResponse(STATUS.internalServerError, 'internal-error', error instanceof Error ? error.message : String(error))
}

export const handleRequest = async (
  request: Request,
  env: Env,
  dependencies: Dependencies = { fetch: (input, init) => fetch(input, init), now: Date.now },
): Promise<Response> => {
  try {
    const url = new URL(request.url)
    const route = ROUTES[url.pathname]
    if (!route) throw new HttpError(STATUS.notFound, 'not-found', `${url.pathname} は存在しません`)
    if (route.method !== request.method) {
      throw new HttpError(STATUS.methodNotAllowed, 'method-not-allowed', `${url.pathname} は ${route.method} で呼び出してください`)
    }

    const missing = REQUIRED_VARIABLES.filter((name) => !env[name])
    if (missing.length > 0) {
      throw new HttpError(STATUS.internalServerError, 'misconfigured', `Workerの環境変数が設定されていません: ${missing.join(', ')}`)
    }

    const twitch = createTwitchClient({ clientId: env.TWITCH_CLIENT_ID, clientSecret: env.TWITCH_CLIENT_SECRET, fetch: dependencies.fetch })
    return await route.handle({ request, url, env, twitch, now: dependencies.now() })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handleRequest(request, env),
}
