/**
 * 管理画面のセッション
 *
 * ログイン済みであることを「ユーザーID.期限.署名」の形の文字列で表し、クッキーに入れる。
 * サーバー側に保存しないため、KVの反映遅れ（store.ts 参照）の影響を受けない。
 * 署名は環境変数 SESSION_SECRET を鍵にしたHMACで、鍵を知らない人は中身を書き換えられない。
 */
import { sign, timingSafeEqual } from './secret'

/** セッションの有効期間（秒）。7日 */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
const MILLISECONDS_PER_SECOND = 1000
const SEPARATOR = '.'
const PART_COUNT = 3

/**
 * セッショントークンを発行する。
 *
 * @param userId TwitchのユーザーID（数字の文字列で、区切り文字を含まない）
 * @param now 現在時刻（ミリ秒）
 */
export const createSessionToken = async (userId: string, secret: string, now: number): Promise<string> => {
  const expiresAt = Math.floor(now / MILLISECONDS_PER_SECOND) + SESSION_TTL_SECONDS
  const payload = `${userId}${SEPARATOR}${expiresAt}`
  return `${payload}${SEPARATOR}${await sign(payload, secret)}`
}

/**
 * セッショントークンを検証し、有効ならユーザーIDを返す。改ざん・期限切れ・形式違いは null。
 */
export const verifySessionToken = async (token: string, secret: string, now: number): Promise<string | null> => {
  const parts = token.split(SEPARATOR)
  const [userId, expiresAtText, signature] = parts
  if (parts.length !== PART_COUNT || !userId || !expiresAtText || !signature) return null

  const expected = await sign(`${userId}${SEPARATOR}${expiresAtText}`, secret)
  if (!timingSafeEqual(signature, expected)) return null

  const expiresAt = Number(expiresAtText)
  if (!Number.isInteger(expiresAt) || expiresAt * MILLISECONDS_PER_SECOND <= now) return null
  return userId
}
