/**
 * ペロペロの呼び出しの組み立て（issue #338）
 *
 * チャンネルポイントと「決まった人のその配信で最初の発言」のトリガー（alert-actions.ts）と、管理画面の試し再生（lick-routes.ts）が、
 * 合成ページの素材「ペロペロ」へ押し出す呼び出しを作る。呼び出しは舐め方の種と、舐める相手1人の名前とアイコンと、
 * 舌が触れるたびに鳴らす効果音の設定（issue #340）だけを持ち、
 * 舐め方の中身（何回・どこを・どれだけしつこく）は合成ページが種から計算する（src/lick/motion.ts）。
 *
 * 注意: 形は合成ページの読み取り（src/lick/call.ts の parseLickCall）と合わせる。worker/ から src/ の型は読み込まない約束なので、ここで持ち直す。
 * 注意: Twitch がアイコンを返さなかった相手（消えたアカウントなど）は iconUrl を null にし、合成ページは名前の頭文字の顔で流す。
 */
import type { LickPlaybackSound } from './lick-sound'

/** 舐められる相手 */
export interface LickTarget {
  readonly name: string
  /** 舐めるアイコン画像の URL。映すアイコンが無ければ null */
  readonly iconUrl: string | null
}

/** 1回のペロペロの呼び出し */
export interface LickCall {
  readonly id: string
  /** 舐め方の種（0 以上 2^32 未満の整数） */
  readonly seed: number
  readonly target: LickTarget
  /** 舌がアイコンに触れるたびに鳴らす効果音（lick-sound.ts の playbackLickSoundOf で音声のURLにしたもの） */
  readonly sound: LickPlaybackSound
}

/** 試し再生で、相手を指定しなかったときに舐める相手の名前 */
const DEMO_TARGET_NAME = '視聴者（試し）'

/** トリガーで舐める相手から呼び出しを作る */
export const lickCallOf = (target: LickTarget, sound: LickPlaybackSound, seed: number, id: string): LickCall => ({ id, seed, target, sound })

/**
 * 管理画面の試し再生の呼び出しを作る。効果音はトリガーと同じ設定で鳴らす。
 *
 * @param target 舐める相手。null なら試しの相手（アイコンなし）を舐める
 */
export const demoLickCallOf = (target: LickTarget | null, sound: LickPlaybackSound, seed: number, id: string): LickCall =>
  lickCallOf(target ?? { name: DEMO_TARGET_NAME, iconUrl: null }, sound, seed, id)

/**
 * 乱数の32ビットの値を舐め方の種にする。呼び出し側は crypto.getRandomValues(new Uint32Array(1)) を渡す。
 *
 * @throws 値が入っていない場合
 */
export const lickSeedOf = (random: Uint32Array): number => {
  const seed = random[0]
  if (seed === undefined) throw new Error('ペロペロの種にする乱数がありません')
  return seed
}
