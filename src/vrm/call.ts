/**
 * VRMの演出の呼び出し（Worker が押し出す、1回ぶんの種と出す VRM）
 *
 * Worker（worker/vrm-call.ts）が、トリガーと管理画面の試し再生で、合成ページの素材「VRM」へ WebSocket で押し出す。
 * 動き方は種だけから合成ページが計算する（motion.ts）ので、呼び出しは種と VRM のURLだけを持つ。
 *
 * 注意: 形が違えば黙って流さずに投げる（素材の箱に失敗を出す）。VRM のURLはこのサイトの素材の経路（/api/media/）に限り、よそのファイルを読み込まない。
 */
import { isRecord } from '../core/api'

/** 1回のVRMの演出の呼び出し */
export interface VrmCall {
  /** 呼び出しごとの識別子 */
  readonly id: string
  /** 動き方の種（0 以上 2^32 未満の整数）。どちらから出てくるか・何回手を振るかはこれだけから決まる */
  readonly seed: number
  /** 出す VRM のURL（素材の経路。オーバーレイ用キーつき） */
  readonly model: string
}

/** 種の上限（この値は含まない）。乱数（mulberry32）の状態が32ビットなので、それに収まる整数にする */
const SEED_LIMIT = 2 ** 32
/** VRM を読みに行ってよい経路（worker/alert-config.ts の mediaPath が作る形） */
export const VRM_MEDIA_PATH = '/api/media/'

/**
 * WebSocket で押し出された文字列を、VRMの演出の呼び出しとして読む。
 *
 * @throws JSONとして読めない・想定した形でない場合
 */
export const parseVrmCall = (payload: string): VrmCall => {
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    throw new Error('押し出されたVRMの演出の呼び出しをJSONとして読めません')
  }
  const invalid = new Error('押し出されたVRMの演出の呼び出しが想定した形ではありません')
  if (!isRecord(body)) throw invalid
  const { id, seed, model } = body
  if (typeof id !== 'string' || typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed >= SEED_LIMIT) throw invalid
  if (typeof model !== 'string' || !model.startsWith(VRM_MEDIA_PATH)) throw invalid
  return { id, seed, model }
}
