/**
 * ペロペロの効果音の設定の形（issue #340）
 *
 * 舌がアイコンに触れるたびに鳴らす効果音の音声と音量。保存する設定（sound は素材のID）と、合成ページが受け取る設定
 * （Worker が素材のIDを音声のURLに置き換えたもの）は同じ形なので、型と読み取りをここに置く
 * （管理画面が Worker の応答を読むとき（src/admin/api.ts）と、合成ページが呼び出しを読むとき（call.ts）に使う）。
 * 値の検証（素材が音声か・音量が 0〜1 か）は Worker（worker/lick-sound.ts）だけが持ち、ここは形だけを見る。
 *
 * 注意: 通信も DOM も持ち込まない。
 * 注意: 形が違う設定は補わずに投げる（Fail-Fast）。欠けた設定を「鳴らさない」と読むと、壊れた設定に気づけないため。
 */
import { isRecord } from '../core/api'

export interface LickSound {
  /** 舌が触れるたびに鳴らす効果音（保存する設定では素材のID、押し出された設定では音声のURL）。鳴らさないなら null */
  readonly sound: string | null
  /** 効果音の音量（0〜1） */
  readonly volume: number
}

/** 効果音の設定の形をしていれば読み、していなければ null を返す（投げる文は呼び出し側が決める） */
export const readLickSoundShape = (value: unknown): LickSound | null => {
  if (!isRecord(value)) return null
  const { sound, volume } = value
  if (sound !== null && typeof sound !== 'string') return null
  if (typeof volume !== 'number') return null
  return { sound, volume }
}

/**
 * Worker が返した保存済みの効果音の設定を読む（管理画面）。
 *
 * @throws 効果音が素材のIDか null でない・音量が数でない場合
 */
export const readLickSound = (value: unknown): LickSound => {
  const sound = readLickSoundShape(value)
  if (sound === null) throw new Error('Workerのペロペロの効果音の設定が想定した形ではありません')
  return sound
}
