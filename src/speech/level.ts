/**
 * 読み上げの音量の変化（マスコットの口パクに使う）
 *
 * 読み上げのページ（裏方の読み上げ・ワイプ）は、合成した音声を鳴らす前に、決まった長さの区切りごとの音量（0〜1）の列を作り、
 * 鳴らしはじめたときに「鳴らしはじめた時刻と音量の列」を、止まったときに「止まった」を同じPCのほかのページへ配る（issue #359）。
 * VRMのマスコットは受け取った列から、その時刻の音量で口を開け閉めする（src/vrm/motion.ts）。
 * 鳴っている音を毎コマ測らず、先に列を作って配るのは、口の開きを時刻だけから決めるため（描画は経過時間だけから決める約束）と、
 * ページをまたいで毎コマ知らせを送らずに済ませるためである。
 *
 * 注意: 通信も DOM も持たない（音声の読み解きと BroadcastChannel は level-channel.ts が受け持つ）。
 * 注意: 知らせの形が違えば黙って捨てずに投げる（受け取る側が箱に失敗を出す）。
 */
import { isRecord } from '../core/api'

/** 音量を測る区切りの長さ（ミリ秒） */
export const SPEECH_LEVEL_FRAME_MS = 20

/** 鳴らしはじめた時刻と、区切りごとの音量の列 */
export interface SpeechLevels {
  /** 鳴らしはじめた時刻（ミリ秒。Date.now() の値） */
  readonly startedAt: number
  /** 1つの区切りの長さ（ミリ秒） */
  readonly frameMs: number
  /** 区切りごとの音量（0〜1）。いちばん大きい区切りが 1 */
  readonly levels: readonly number[]
}

/** 読み上げのページから配る知らせ */
export type SpeechLevelMessage =
  | ({ readonly type: 'start'; readonly id: string } & SpeechLevels)
  | { readonly type: 'stop'; readonly id: string }

/**
 * これより小さい音量（二乗平均平方根）しかない音声は無音として扱う。
 * いちばん大きい区切りを 1 にそろえるので、無音の音声で雑音を大きくして口を動かさないための下限
 */
const SILENCE_RMS = 1e-3
/** 音量の列を配るときに丸める桁（知らせを小さく保つ） */
const LEVEL_PRECISION = 100

/**
 * 音声の標本から、区切り（SPEECH_LEVEL_FRAME_MS）ごとの音量の列を作る。
 *
 * 区切りごとの二乗平均平方根を、いちばん大きい区切りが 1 になるようにそろえる（話者や音量の設定によらず口が開くように）。
 *
 * @param samples 1チャンネルぶんの標本（−1〜1）
 * @param sampleRate 1秒あたりの標本の数
 */
export const envelopeOf = (samples: ArrayLike<number>, sampleRate: number): number[] => {
  const frameSamples = Math.max(1, Math.round((sampleRate * SPEECH_LEVEL_FRAME_MS) / 1000))
  const frames = Math.ceil(samples.length / frameSamples)
  const rms = Array.from({ length: frames }, (_, frame) => {
    const start = frame * frameSamples
    const end = Math.min(samples.length, start + frameSamples)
    let sum = 0
    for (let index = start; index < end; index += 1) sum += (samples[index] ?? 0) ** 2
    return Math.sqrt(sum / (end - start))
  })
  const peak = Math.max(0, ...rms)
  if (peak < SILENCE_RMS) return rms.map(() => 0)
  return rms.map((value) => Math.round((value / peak) * LEVEL_PRECISION) / LEVEL_PRECISION)
}

/**
 * 配られた知らせを読む。
 *
 * @throws 想定した形でない場合
 */
export const parseSpeechLevelMessage = (data: unknown): SpeechLevelMessage => {
  const invalid = new Error('読み上げの音量の知らせが想定した形ではありません')
  if (!isRecord(data) || typeof data.id !== 'string') throw invalid
  const { type, id } = data
  if (type === 'stop') return { type, id }
  if (type !== 'start') throw invalid
  const { startedAt, frameMs, levels } = data
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) throw invalid
  if (typeof frameMs !== 'number' || !(frameMs > 0)) throw invalid
  if (!Array.isArray(levels) || !levels.every((level): level is number => typeof level === 'number' && level >= 0 && level <= 1)) throw invalid
  return { type, id, startedAt, frameMs, levels }
}
