/**
 * 試し再生の相手の読み取り（ツイスター・ペロペロの試し再生で共有する）
 *
 * 管理画面の試し再生（POST /api/admin/twister/demo・POST /api/admin/lick/demo）は、本文の userName に Twitch のログイン名を入れると、
 * その人を相手とみなして流す。打ち間違いに気づけるよう、Twitch にいるかをここで確かめ、表示名とアイコンを引く。
 *
 * 注意: ログイン名の打ち間違いは、試しの相手に差し替えずに 400・404 で返す。Twitch の失敗は 502 で返す。
 */
import { HttpError, STATUS, type Context } from './http'

/** Twitch のログイン名の形（英数字とアンダースコアの25文字まで） */
const TWITCH_LOGIN_PATTERN = /^[A-Za-z0-9_]{1,25}$/

/** 試し再生の相手（Twitch から引いた表示名とアイコン） */
export interface DemoUser {
  readonly name: string
  readonly iconUrl: string | null
}

/**
 * 試し再生の本文から、相手とみなす人を読む。本文が空か、ユーザー名が空なら null（呼び出し側が試しの相手で流す）。
 *
 * @throws HttpError 本文が JSON でない・ユーザー名がログイン名の形でない（400）・そのログイン名の人がいない（404）・Twitch の失敗（502）
 */
export const readDemoUser = async (context: Context): Promise<DemoUser | null> => {
  const text = await context.request.text()
  if (text.trim() === '') return null
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  }
  const fields: Record<string, unknown> = typeof body === 'object' && body !== null ? { ...body } : {}
  const { userName } = fields
  if (userName === undefined || userName === '') return null
  if (typeof userName !== 'string' || !TWITCH_LOGIN_PATTERN.test(userName)) {
    throw new HttpError(STATUS.badRequest, 'invalid-user-name', '相手とみなすユーザー名は、Twitch のログイン名（英数字とアンダースコア）で入れてください')
  }
  const user = await (async () => {
    try {
      return await context.twitch.getUserByLogin(await context.twitch.getAppAccessToken(), userName)
    } catch (error) {
      throw new HttpError(STATUS.badGateway, 'twitch-user-failed', `Twitch から ${userName} を引けませんでした: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()
  if (user === null) throw new HttpError(STATUS.notFound, 'unknown-twitch-user', `Twitch にログイン名 ${userName} の配信者がいません`)
  return { name: user.displayName, iconUrl: user.profileImageUrl }
}
