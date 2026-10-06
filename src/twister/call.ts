/**
 * ツイスターの呼び出し（Worker が押し出す、1回の対戦の種と2人）
 *
 * Worker（worker/twister-call.ts）が、レイドを受けたときと管理画面の試し再生で、合成ページの素材「ツイスター」へ WebSocket で押し出す。
 * 対戦の中身（指示・倒れ方・勝敗）は種だけから合成ページが計算する（game.ts）ので、呼び出しは種と2人の名前・アイコンだけを持つ。
 *
 * 注意: 形が違えば黙って流さずに投げる（素材の箱に失敗を出す）。アイコンは https の URL か null（試し再生の相手など、映すアイコンが無い）。
 */
import { isRecord } from '../core/api'

/** 対戦する1人 */
export interface TwisterPlayer {
  /** 画面に出す名前（Twitch の表示名） */
  readonly name: string
  /** 顔に貼るアイコン画像の URL。映すアイコンが無ければ null（頭文字の顔にする） */
  readonly iconUrl: string | null
}

/** 1回の対戦の呼び出し */
export interface TwisterCall {
  /** 呼び出しごとの識別子 */
  readonly id: string
  /** 対戦の種（0 以上 2^32 未満の整数）。指示・倒れ方・勝敗はこれだけから決まる */
  readonly seed: number
  /** 0番がレイドした人、1番が配信者 */
  readonly players: readonly [TwisterPlayer, TwisterPlayer]
}

/** 種の上限（この値は含まない）。乱数（mulberry32）の状態が32ビットなので、それに収まる整数にする */
const SEED_LIMIT = 2 ** 32

const readPlayer = (value: unknown): TwisterPlayer | null => {
  if (!isRecord(value)) return null
  const { name, iconUrl } = value
  if (typeof name !== 'string' || name === '') return null
  if (iconUrl !== null && (typeof iconUrl !== 'string' || !iconUrl.startsWith('https://'))) return null
  return { name, iconUrl }
}

/**
 * WebSocket で押し出された文字列を、ツイスターの呼び出しとして読む。
 *
 * @throws JSONとして読めない・想定した形でない場合
 */
export const parseTwisterCall = (payload: string): TwisterCall => {
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    throw new Error('押し出されたツイスターの呼び出しをJSONとして読めません')
  }
  const invalid = new Error('押し出されたツイスターの呼び出しが想定した形ではありません')
  if (!isRecord(body)) throw invalid
  const { id, seed, players } = body
  if (typeof id !== 'string' || typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed >= SEED_LIMIT) throw invalid
  if (!Array.isArray(players) || players.length !== 2) throw invalid
  const raider = readPlayer(players[0])
  const streamer = readPlayer(players[1])
  if (raider === null || streamer === null) throw invalid
  return { id, seed, players: [raider, streamer] }
}
