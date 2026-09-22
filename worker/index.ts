/**
 * WorkerのAPI（/api/*）の入口
 *
 * 静的アセットでは扱えない「秘密を持つ処理」だけを受け持つ。リクエストを経路の一覧と照らし合わせ、各経路の処理へ渡す。
 *
 * | 経路 | 守り方 | 役割 |
 * |---|---|---|
 * | GET  /api/auth/login             | なし（?role=bot はセッション） | Twitchの認可ページへ送る |
 * | GET  /api/auth/callback          | OAuthのstate（botはセッションも） | トークンを保管し、配信者本人ならセッションを開始してダッシュボードへ送る |
 * | POST /api/auth/logout            | なし           | セッションを終える |
 * | GET  /api/me                     | セッション     | ログイン中の配信者とオーバーレイ用キーを返す |
 * | GET・PUT /api/admin/config       | セッション     | アラートの設定の取得・保存 |
 * | GET・POST /api/admin/media       | セッション     | 素材の一覧・アップロード |
 * | DELETE /api/admin/media/:id      | セッション     | 素材の削除 |
 * | POST /api/admin/overlay-key      | セッション     | オーバーレイ用キーの再発行 |
 * | GET  /api/admin/bot              | セッション     | チャットボットの接続状態 |
 * | DELETE /api/admin/bot            | セッション     | チャットボットの切断 |
 * | POST /api/admin/bot/messages     | セッション     | チャットボットの名前でチャットを送る |
 * | POST /api/admin/bot/device-code  | セッション     | 別の端末で接続するためのコードを発行する |
 * | POST /api/admin/bot/device-token | セッション     | 発行したコードをトークンに交換する（未認可なら待っている状態を返す） |
 * | GET・PUT /api/admin/bot/commands | セッション     | チャットのコマンドの取得・保存 |
 * | GET・PUT /api/admin/bot/moderation | セッション   | チャットの自動モデレーションの設定の取得・保存 |
 * | GET  /api/admin/rewards          | セッション     | チャンネルポイント報酬の一覧 |
 * | GET  /api/admin/stats/sessions   | セッション     | 配信セッションの一覧 |
 * | GET  /api/admin/stats/sessions/:id | セッション   | 配信セッションと視聴者数の時系列 |
 * | GET  /api/admin/stats/followers  | セッション     | フォロワー数の時系列 |
 * | GET  /api/admin/stats/failures   | セッション     | 記録の収集の失敗の一覧 |
 * | POST /api/eventsub/subscriptions | オーバーレイ用キー | EventSubの購読を代行する |
 * | POST /api/eventsub/webhook       | Twitchの署名   | EventSubの通知を受け、イベントの件数と配信の開始・終了を記録する |
 * | POST /api/overlay/alert          | オーバーレイ用キー | 届いた通知に対して、再生するアラートを返す |
 * | GET  /api/media/:id              | オーバーレイ用キーかセッション | 素材の中身を返す |
 *
 * これとは別に、cron（wrangler.jsonc の triggers.crons）から scheduled が呼ばれ、配信の記録を収集する（collect.ts）。
 *
 * Twitchのトークンは応答に含めない。失敗は { error: { code, message } } の形で返し、黙って成功扱いにしない。
 * fetch と現在時刻を引数で受け取るのは、テストで差し替えるため。
 */
import { deleteMedia, getConfig, getMedia, getRewards, postMedia, postOverlayKey, putConfig } from './admin-routes'
import {
  deleteBot,
  getBot,
  getBotCommands,
  getBotModeration,
  postBotDeviceCode,
  postBotDeviceToken,
  postBotMessage,
  putBotCommands,
  putBotModeration,
} from './bot-routes'
import { ConfigError } from './alert-config'
import { CALLBACK_PATH, callback, login, logout, me } from './auth-routes'
import { collectStats } from './collect'
import { HttpError, STATUS, errorResponse, type Context, type Env } from './http'
import { media, overlayAlert, subscribe } from './overlay-routes'
import { getStatsFailures, getStatsFollowers, getStatsSession, getStatsSessions } from './stats-routes'
import { AuthError } from './token'
import { WEBHOOK_PATH, eventsubWebhook } from './webhook-routes'
import { chatBadges, chatChannel, chatCheermotes } from './chat-routes'
import { TwitchApiError, createTwitchClient, type TwitchClient } from './twitch'

export type { Env } from './http'

interface Dependencies {
  fetch: typeof fetch
  /** 現在時刻（ミリ秒） */
  now(): number
  /** 指定した時間だけ待つ。アナウンスの送信間隔を空けるのに使う（テストでは実際に待たせない） */
  wait(milliseconds: number): Promise<void>
}

interface Route {
  method: string
  /** 経路のパス。:名前 の部分は任意の1区切りに当てはまり、Context.params に入る */
  path: string
  handle(context: Context): Response | Promise<Response>
}

const REQUIRED_VARIABLES = ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_BROADCASTER_ID', 'SESSION_SECRET', 'EVENTSUB_SECRET'] as const
const PARAM_PREFIX = ':'

const ROUTES: readonly Route[] = [
  { method: 'GET', path: '/api/auth/login', handle: login },
  { method: 'GET', path: CALLBACK_PATH, handle: callback },
  { method: 'POST', path: '/api/auth/logout', handle: logout },
  { method: 'GET', path: '/api/me', handle: me },
  { method: 'GET', path: '/api/admin/config', handle: getConfig },
  { method: 'PUT', path: '/api/admin/config', handle: putConfig },
  { method: 'GET', path: '/api/admin/media', handle: getMedia },
  { method: 'POST', path: '/api/admin/media', handle: postMedia },
  { method: 'DELETE', path: '/api/admin/media/:id', handle: deleteMedia },
  { method: 'POST', path: '/api/admin/overlay-key', handle: postOverlayKey },
  { method: 'GET', path: '/api/admin/bot', handle: getBot },
  { method: 'DELETE', path: '/api/admin/bot', handle: deleteBot },
  { method: 'POST', path: '/api/admin/bot/messages', handle: postBotMessage },
  { method: 'POST', path: '/api/admin/bot/device-code', handle: postBotDeviceCode },
  { method: 'POST', path: '/api/admin/bot/device-token', handle: postBotDeviceToken },
  { method: 'GET', path: '/api/admin/bot/commands', handle: getBotCommands },
  { method: 'PUT', path: '/api/admin/bot/commands', handle: putBotCommands },
  { method: 'GET', path: '/api/admin/bot/moderation', handle: getBotModeration },
  { method: 'PUT', path: '/api/admin/bot/moderation', handle: putBotModeration },
  { method: 'GET', path: '/api/admin/rewards', handle: getRewards },
  { method: 'GET', path: '/api/admin/stats/sessions', handle: getStatsSessions },
  { method: 'GET', path: '/api/admin/stats/sessions/:id', handle: getStatsSession },
  { method: 'GET', path: '/api/admin/stats/followers', handle: getStatsFollowers },
  { method: 'GET', path: '/api/admin/stats/failures', handle: getStatsFailures },
  { method: 'POST', path: '/api/eventsub/subscriptions', handle: subscribe },
  { method: 'POST', path: WEBHOOK_PATH, handle: eventsubWebhook },
  { method: 'GET', path: '/api/chat/channel', handle: chatChannel },
  { method: 'GET', path: '/api/chat/badges', handle: chatBadges },
  { method: 'GET', path: '/api/chat/cheermotes', handle: chatCheermotes },
  { method: 'POST', path: '/api/overlay/alert', handle: overlayAlert },
  { method: 'GET', path: '/api/media/:id', handle: media },
]

/** パスが経路に当てはまれば :名前 の値を返す。当てはまらなければ null */
const matchPath = (routePath: string, pathname: string): Record<string, string> | null => {
  const routeSegments = routePath.split('/')
  const segments = pathname.split('/')
  if (routeSegments.length !== segments.length) return null

  const params: Record<string, string> = {}
  for (const [index, routeSegment] of routeSegments.entries()) {
    const segment = segments[index] ?? ''
    if (routeSegment.startsWith(PARAM_PREFIX)) {
      if (segment === '') return null
      params[routeSegment.slice(PARAM_PREFIX.length)] = decodeURIComponent(segment)
    } else if (routeSegment !== segment) {
      return null
    }
  }
  return params
}

/** パスとメソッドから経路を探す。パスがなければ404、パスはあるがメソッドが違えば405 */
const findRoute = (method: string, pathname: string): { route: Route; params: Record<string, string> } => {
  const candidates = ROUTES.flatMap((route) => {
    const params = matchPath(route.path, pathname)
    return params ? [{ route, params }] : []
  })
  if (candidates.length === 0) throw new HttpError(STATUS.notFound, 'not-found', `${pathname} は存在しません`)

  const found = candidates.find(({ route }) => route.method === method)
  if (!found) {
    const allowed = candidates.map(({ route }) => route.method).join('・')
    throw new HttpError(STATUS.methodNotAllowed, 'method-not-allowed', `${pathname} は ${allowed} で呼び出してください`)
  }
  return found
}

const toErrorResponse = (error: unknown): Response => {
  if (error instanceof HttpError) return errorResponse(error.status, error.code, error.message)
  if (error instanceof ConfigError) return errorResponse(STATUS.badRequest, 'invalid-config', error.message, error.problems)
  if (error instanceof AuthError) return errorResponse(STATUS.unauthorized, error.code, error.message)
  if (error instanceof TwitchApiError) return errorResponse(STATUS.badGateway, 'twitch-error', error.message)
  if (error instanceof URIError) return errorResponse(STATUS.badRequest, 'invalid-path', 'URLのパスを解釈できません')
  console.error(error)
  return errorResponse(STATUS.internalServerError, 'internal-error', error instanceof Error ? error.message : String(error))
}

const DEFAULT_DEPENDENCIES: Dependencies = {
  fetch: (input, init) => fetch(input, init),
  now: Date.now,
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}

/** 環境変数が揃っていることを確かめてから、Twitchのクライアントを作る */
const createClient = (env: Env, dependencies: Pick<Dependencies, 'fetch'>): TwitchClient => {
  const missing = REQUIRED_VARIABLES.filter((name) => !env[name])
  if (missing.length > 0) {
    throw new HttpError(STATUS.internalServerError, 'misconfigured', `Workerの環境変数が設定されていません: ${missing.join(', ')}`)
  }
  return createTwitchClient({ clientId: env.TWITCH_CLIENT_ID, clientSecret: env.TWITCH_CLIENT_SECRET, fetch: dependencies.fetch })
}

export const handleRequest = async (request: Request, env: Env, dependencies: Dependencies = DEFAULT_DEPENDENCIES): Promise<Response> => {
  try {
    const url = new URL(request.url)
    const { route, params } = findRoute(request.method, url.pathname)
    const twitch = createClient(env, dependencies)
    return await route.handle({ request, url, params, env, twitch, now: dependencies.now(), wait: dependencies.wait })
  } catch (error) {
    return toErrorResponse(error)
  }
}

/**
 * cron から呼ばれ、配信の記録を1回分収集する。
 *
 * 注意: 失敗を握りつぶさずに投げる。Cloudflare側でも cron の実行が失敗として残る。
 */
export const handleScheduled = async (env: Env, dependencies: Pick<Dependencies, 'fetch' | 'now'> = DEFAULT_DEPENDENCIES): Promise<void> => {
  const twitch = createClient(env, dependencies)
  await collectStats({ db: env.DB, store: env.STORE, twitch, broadcasterId: env.TWITCH_BROADCASTER_ID, now: dependencies.now() })
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handleRequest(request, env),
  scheduled: (_controller: unknown, env: Env): Promise<void> => handleScheduled(env),
}
