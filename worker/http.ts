/**
 * WorkerのAPIに共通するHTTPの部品
 *
 * 環境（バインディングとシークレット）の型、経路の処理が受け取る文脈、状態コード、クッキー、
 * そして「誰からのリクエストか」の確認（配信者のセッション・オーバーレイ用キー・送信元のサイト）をまとめる。
 */
import type { TextGenerator, WorkersAi } from './llm'
import type { AdBreakTimerNamespace } from './ad-break-timer'
import type { AlertChannelNamespace } from './alert-channel'
import type { Database } from './database'
import type { MediaBucket } from './media-bucket'
import { isValidOverlayKey } from './overlay-key'
import { verifySessionToken } from './session'
import type { KeyValueStore } from './store'
import type { TwitchClient } from './twitch'

/** wrangler.jsonc のバインディングと、シークレット（.dev.vars／ダッシュボードで設定） */
export interface Env {
  /** Twitchのトークン・オーバーレイ用キー・アラートの設定（KV） */
  STORE: KeyValueStore
  /** アラートの素材（R2） */
  MEDIA: MediaBucket
  /** 配信の記録（D1） */
  DB: Database
  /** オーバーレイへアラートを配る Durable Object。Workerは接続を保持できないため、配送だけをここに任せる */
  ALERTS: AlertChannelNamespace
  /**
   * 広告の終了の時刻を預かる Durable Object。
   *
   * Twitchは広告の開始しか知らせてこないので、終わる時刻に起こしてもらうタイマーとして使う
   * （Workerはタイマーを持てない。worker/ad-break-timer.ts）。
   */
  AD_BREAKS: AdBreakTimerNamespace
  /**
   * Cloudflare の Workers AI のバインディング。
   *
   * 呼び出し側はこれを直接使わず、設定（worker/llm-config.ts）に従って呼び先を決める TextGenerator
   * （Context.llm）を通す。提供元に OpenRouter を選んでいるときは、このバインディングは呼ばれない。
   */
  AI: WorkersAi
  TWITCH_CLIENT_ID: string
  TWITCH_CLIENT_SECRET: string
  /** 管理画面へのログインを許す、配信者のTwitchユーザーID（数字） */
  TWITCH_BROADCASTER_ID: string
  /** セッションの署名に使うランダムな文字列 */
  SESSION_SECRET: string
  /** EventSubのWebhookの署名に使うランダムな文字列（Twitchの決まりで10〜100文字のASCII） */
  EVENTSUB_SECRET: string
  /**
   * OpenRouter のAPIキー。
   *
   * LLMの提供元に OpenRouter を選んだときだけ要る（worker/llm.ts）ので、設定していなくてもWorkerは動く。
   * 選んでいるのに無ければ、黙って Workers AI へ落とさずに失敗させる（Fail-Fast）。
   */
  OPENROUTER_API_KEY?: string
}

/** 経路の処理が受け取る文脈 */
export interface Context {
  request: Request
  url: URL
  /** 経路の :名前 の部分に当てはまった値（URLデコード済み） */
  params: Readonly<Record<string, string>>
  env: Env
  twitch: TwitchClient
  /**
   * 文面を作らせるLLM（worker/llm.ts）。
   *
   * 提供元とモデルは保存された設定（llm-settings）が決めるので、経路の処理は用途（chat・summary）を指名するだけでよい。
   * 設定の読み出しは最初に使われたときの1回だけなので、LLMを使わない通知では読み出しも起きない。
   */
  llm: TextGenerator
  /** 現在時刻（ミリ秒） */
  now: number
  /**
   * 外への通信。
   *
   * Twitchへの通信は twitch（TwitchClient）が持つので、ここから呼ぶのは Twitch 以外の相手
   * （OpenRouter のモデルの一覧など）である。テストで差し替えられるよう引数で受け取る。
   */
  fetch: typeof fetch
  /**
   * 指定した時間だけ待つ。
   *
   * アナウンスは2秒に1回しか送れないため、枠を確保したうえで自分の順番まで待つのに使う（bot-chat.ts）。
   * テストで差し替えられるよう、setTimeout を直接呼ばずにここから受け取る。
   */
  wait(milliseconds: number): Promise<void>
  /**
   * 応答を返したあとに続きを走らせる（Cloudflare の ExecutionContext.waitUntil）。
   *
   * EventSubのWebhookは、応答が遅れるとTwitchが同じ通知を再送し、失敗が続けば購読を失効させる。
   * LLMに文面を作らせる動作（aiChat）はTwitchへ2xxを返してから走らせたいので、これに預ける。
   * テストでは預けられた処理を集めて、まとめて待てるようにする。
   */
  waitUntil(promise: Promise<unknown>): void
}

export const SESSION_COOKIE = '__Host-session'

export const STATUS = {
  ok: 200,
  created: 201,
  noContent: 204,
  found: 302,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  methodNotAllowed: 405,
  conflict: 409,
  payloadTooLarge: 413,
  unsupportedMediaType: 415,
  internalServerError: 500,
  badGateway: 502,
} as const

/** 決まった状態コードとエラーコードで応答させるためのエラー */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** 失敗の応答。problems は、問題点が複数あるとき（設定の検証）に添える */
export const errorResponse = (status: number, code: string, message: string, problems?: readonly string[]): Response =>
  Response.json({ error: { code, message, ...(problems ? { problems } : {}) } }, { status })

export const setCookie = (name: string, value: string, maxAgeSeconds: number): string =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`

export const readCookie = (request: Request, name: string): string | null => {
  const pairs = (request.headers.get('Cookie') ?? '').split(';').map((pair) => pair.trim())
  const found = pairs.find((pair) => pair.startsWith(`${name}=`))
  return found ? found.slice(name.length + 1) : null
}

/** 配信者本人の有効なセッションがあるか */
export const hasSession = async ({ request, env, now }: Context): Promise<boolean> => {
  const token = readCookie(request, SESSION_COOKIE)
  const userId = token ? await verifySessionToken(token, env.SESSION_SECRET, now) : null
  return userId === env.TWITCH_BROADCASTER_ID
}

/** 配信者本人の有効なセッションがなければ401にする */
export const requireSession = async (context: Context): Promise<void> => {
  if (!(await hasSession(context))) {
    throw new HttpError(STATUS.unauthorized, 'unauthorized', 'ログインが必要です。/api/auth/login からログインしてください')
  }
}

/**
 * 管理用API（/api/admin/*）の入口。配信者のセッションを要求し、書き換えを伴うメソッドでは送信元のサイトも確かめる。
 *
 * 注意: クッキーは SameSite=Lax なので別サイトからのPOSTには付かないが、ブラウザの設定に頼り切らず、
 * ブラウザが必ず付ける Origin ヘッダーでも確かめる（CSRF対策）。
 */
export const requireAdmin = async (context: Context): Promise<void> => {
  await requireSession(context)
  const { request, url } = context
  if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) {
    throw new HttpError(STATUS.forbidden, 'cross-origin', '管理画面と同じサイトからのリクエストだけを受け付けます')
  }
}

/** URLの ?key= が発行済みのオーバーレイ用キーと一致しなければ401にする */
export const requireOverlayKey = async ({ url, env }: Context): Promise<string> => {
  const key = url.searchParams.get('key') ?? ''
  if (!(await isValidOverlayKey(env.STORE, key))) {
    throw new HttpError(STATUS.unauthorized, 'invalid-overlay-key', 'オーバーレイ用キーが正しくありません。管理画面のURLを貼り直してください')
  }
  return key
}
