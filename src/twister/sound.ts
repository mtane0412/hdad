/**
 * ツイスターの BGM の設定の形
 *
 * 対戦のあいだ流す BGM の音声と音量。保存する設定（bgm は素材のID）と、合成ページが受け取る設定
 * （Worker が素材のIDを音声のURLに置き換えたもの）は同じ形なので、型と読み取りをここに置く
 * （管理画面が Worker の応答を読むとき（api.ts）と、合成ページが呼び出しを読むとき（call.ts）に使う）。
 * 値の検証（素材が音声か・音量が 0〜1 か）は Worker（worker/twister-sound.ts）だけが持ち、ここは形だけを見る。
 *
 * 注意: 通信も DOM も持ち込まない。
 * 注意: 形が違う設定は補わずに投げる（Fail-Fast）。欠けた設定を「流さない」と読むと、壊れた設定に気づけないため。
 */
import { isRecord } from '../core/api'

export interface TwisterSound {
  /** 対戦のあいだ流す BGM（保存する設定では素材のID、押し出された設定では音声のURL）。流さないなら null */
  readonly bgm: string | null
  /** BGM の音量（0〜1） */
  readonly bgmVolume: number
}

/** BGM の設定の形をしていれば読み、していなければ null を返す（投げる文は呼び出し側が決める） */
export const readTwisterSoundShape = (value: unknown): TwisterSound | null => {
  if (!isRecord(value)) return null
  const { bgm, bgmVolume } = value
  if (bgm !== null && typeof bgm !== 'string') return null
  if (typeof bgmVolume !== 'number') return null
  return { bgm, bgmVolume }
}

/**
 * Worker が返した保存済みの BGM の設定を読む（管理画面）。
 *
 * @throws BGM が素材のIDか null でない・音量が数でない場合
 */
export const readTwisterSound = (value: unknown): TwisterSound => {
  const sound = readTwisterSoundShape(value)
  if (sound === null) throw new Error('Workerのツイスターの BGM の設定が想定した形ではありません')
  return sound
}
