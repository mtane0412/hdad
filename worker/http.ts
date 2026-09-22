/**
 * WorkerのAPIに共通するHTTPの部品
 *
 * 環境（バインディングとシークレット）の型、経路の処理が受け取る文脈、状態コード、クッキー、
 * そして「誰からのリクエストか」の確認（配信者のセッション・オーバーレイ用キー・送信元のサイト）をまとめる。
 */
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
  TWITCH_CLIENT_ID: string
  TWITCH_CLIENT_SECRET: string
  /** 管理画面へのログインを許す、配信者のTwitchユーザーID（数字） */
  TWITCH_BROADCASTER_ID: string
  /** セッションの署名に使うランダムな文字列 */
  SESSION_SECRET: string
  /** EventSubのWebhookの署名に使うランダムな文字列（Twitchの決まりで10〜100文字のASCII） */
  EVENTSUB_SECRET: string
}

/** 経路の処理が受け取る文脈 */
export interface Context {
  request: Request
  url: URL
  /** 経路の :名前 の部分に当てはまった値（URLデコード済み） */
  params: Readonly<Record<string, string>>
  env: Env
  twitch: TwitchClient
  /** 現在時刻（ミリ秒） */
  now: number
  /**
   * 指定した時間だけ待つ。
   *
   * アナウンスは2秒に1回しか送れないため、枠を確保したうえで自分の順番まで待つのに使う（bot-chat.ts）。
   * テストで差し替えられるよう、setTimeout を直接呼ばずにここから受け取る。
   */
  wait(milliseconds: number): Promise<void>
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
