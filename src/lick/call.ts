/**
 * ペロペロの呼び出し（Worker が押し出す、1回ぶんの種と舐める相手）
 *
 * Worker（worker/lick-call.ts）が、チャンネルポイントの交換・決まった人のその配信で最初の発言と、管理画面の試し再生で、
 * 合成ページの素材「ペロペロ」へ WebSocket で押し出す。舐め方は種だけから合成ページが計算する（motion.ts）ので、
 * 呼び出しは種と相手1人の名前・アイコンと、舌が触れるたびに鳴らす効果音の設定（Worker の worker/lick-sound.ts が素材のIDを音声のURLに置き換えたもの）だけを持つ。
 *
 * 注意: 形が違えば黙って流さずに投げる（素材の箱に失敗を出す）。アイコンは https の URL か null（試し再生の相手など、映すアイコンが無い）。
 */
import { isRecord } from '../core/api'
import { readLickSoundShape, type LickSound } from './sound'

/** 舐められる相手 */
export interface LickTarget {
  /** 画面に出す名前（Twitch の表示名） */
  readonly name: string
  /** 舐めるアイコン画像の URL。映すアイコンが無ければ null（頭文字の顔にする） */
  readonly iconUrl: string | null
}

/** 1回のペロペロの呼び出し */
export interface LickCall {
  /** 呼び出しごとの識別子 */
  readonly id: string
  /** 舐め方の種（0 以上 2^32 未満の整数）。舐める回数・位置・しつこさはこれだけから決まる */
  readonly seed: number
  readonly target: LickTarget
  /** 舌が触れるたびに鳴らす効果音。sound は音声のURL（オーバーレイ用キーつき）で、鳴らさないなら null */
  readonly sound: LickSound
}

/** 種の上限（この値は含まない）。乱数（mulberry32）の状態が32ビットなので、それに収まる整数にする */
const SEED_LIMIT = 2 ** 32

const readTarget = (value: unknown): LickTarget | null => {
  if (!isRecord(value)) return null
  const { name, iconUrl } = value
  if (typeof name !== 'string' || name === '') return null
  if (iconUrl !== null && (typeof iconUrl !== 'string' || !iconUrl.startsWith('https://'))) return null
  return { name, iconUrl }
}

/**
 * WebSocket で押し出された文字列を、ペロペロの呼び出しとして読む。
 *
 * @throws JSONとして読めない・想定した形でない場合
 */
export const parseLickCall = (payload: string): LickCall => {
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    throw new Error('押し出されたペロペロの呼び出しをJSONとして読めません')
  }
  const invalid = new Error('押し出されたペロペロの呼び出しが想定した形ではありません')
  if (!isRecord(body)) throw invalid
  const { id, seed, target: targetValue, sound: soundValue } = body
  if (typeof id !== 'string' || typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed >= SEED_LIMIT) throw invalid
  const target = readTarget(targetValue)
  if (target === null) throw invalid
  const sound = readLickSoundShape(soundValue)
  if (sound === null) throw invalid
  return { id, seed, target, sound }
}
