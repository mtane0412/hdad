/**
 * 読み上げの音量の変化を、同じPCのほかのページへ配る・受け取る（BroadcastChannel）
 *
 * 読み上げのページ（裏方の読み上げ・ワイプ）は、合成した音声を読み解いて区切りごとの音量の列を作り（level.ts の envelopeOf）、
 * 鳴らしはじめたときと止まったときに知らせる。VRMのマスコット（合成ページの素材「VRM」）はそれを受け取って口を開け閉めする（issue #359）。
 * 同じオリジンのページどうしなら、裏方（別のブラウザソース）からでも、同じ合成ページの中のワイプからでも届く。
 *
 * 注意: 音声の読み解きと BroadcastChannel を扱うので、テストを持たない（列の作り方と知らせの読み方は level.ts でテストする）。
 * 注意: 配る側は、受け取る相手がいなくても知らせを送るだけで待たない（マスコットを置いていなくても読み上げは変わらない）。
 */
import { envelopeOf, parseSpeechLevelMessage, SPEECH_LEVEL_FRAME_MS, type SpeechLevelMessage } from './level'

/** 知らせを流す BroadcastChannel の名前 */
const SPEECH_LEVEL_CHANNEL = 'hdad-speech-level'
/** 音声を読み解くときの標本の頻度（1秒あたり）。音量の変化を測るだけなので、声が収まる程度の頻度にする */
const DECODE_SAMPLE_RATE = 24_000

/**
 * 合成した音声を読み解いて、区切りごとの音量の列を作る。
 *
 * @throws 音声として読み解けない場合
 */
export const measureSpeechLevels = async (audio: Blob): Promise<number[]> => {
  // OfflineAudioContext は音を鳴らさないので、ブラウザの自動再生の制限を受けずに読み解ける
  const buffer = await new OfflineAudioContext(1, 1, DECODE_SAMPLE_RATE).decodeAudioData(await audio.arrayBuffer())
  return envelopeOf(buffer.getChannelData(0), buffer.sampleRate)
}

export interface SpeechLevelSender {
  /** 鳴らしはじめたことを知らせる */
  start(id: string, levels: readonly number[], startedAt: number): void
  /** 鳴り終えた・止められたことを知らせる */
  stop(id: string): void
}

/** 読み上げの音量の変化を配る口を作る */
export const createSpeechLevelSender = (): SpeechLevelSender => {
  const channel = new BroadcastChannel(SPEECH_LEVEL_CHANNEL)
  const post = (message: SpeechLevelMessage): void => channel.postMessage(message)
  return {
    start: (id, levels, startedAt) => post({ type: 'start', id, startedAt, frameMs: SPEECH_LEVEL_FRAME_MS, levels }),
    stop: (id) => post({ type: 'stop', id }),
  }
}

/**
 * 読み上げの音量の変化を受け取りはじめる。
 *
 * @param onMessage 読めた知らせを受け取る
 * @param onError 形の違う知らせが届いたときに呼ばれる（黙って捨てない）
 */
export const listenSpeechLevels = (onMessage: (message: SpeechLevelMessage) => void, onError: (error: unknown) => void): void => {
  const channel = new BroadcastChannel(SPEECH_LEVEL_CHANNEL)
  channel.addEventListener('message', (event: MessageEvent) => {
    try {
      onMessage(parseSpeechLevelMessage(event.data))
    } catch (error) {
      onError(error)
    }
  })
}
