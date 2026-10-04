/**
 * さくらのAI Engine での合成（Worker 経由）
 *
 * 読み上げの合成先にさくらを選んだとき（issue #225）に、読み上げのページが使う。さくらのAPIキーはブラウザに置けないので、
 * さくらを直接呼ばず、Worker の経路（worker/speech-routes.ts）をオーバーレイ用キーで呼ぶ。
 * ローカルの VOICEVOX ENGINE の呼び出し（voicevox.ts）と同じ形（Voicevox）にそろえ、task.ts が合成先で差し替えられるようにする。
 *
 * 注意: 話者と読み上げ速度は送らない。Worker が保存済みの設定から取るためで（設定の持ち主を1か所にする）、
 * synthesize の voice は受け取るだけで使わない。読み上げのページの設定は30秒おきの読み直しなので、Worker のほうが新しい。
 * 注意: 失敗は黙って無音にせずエラーにする（Fail-Fast）。Worker の理由（さくらが話者を拒んだ、など）をそのまま文面に出す。
 * fetch を引数で受け取るのはテストで差し替えるため。
 */
import { toApiError } from '../core/api'
import type { Voicevox } from './voicevox'

const CHECK_PATH = '/api/overlay/speech/check'
const SYNTHESIS_PATH = '/api/overlay/speech/synthesis'

/** Worker を呼び、失敗なら Worker の理由でエラーにする。成功の応答は本文を読まずに返す（音声を受け取るため） */
const callWorker = async (fetchImpl: typeof fetch, path: string, init: RequestInit): Promise<Response> => {
  const response = await fetchImpl(path, init)
  if (!response.ok) throw toApiError(response.status, await response.json().catch(() => null))
  return response
}

/**
 * さくらのAI Engine での合成を組み立てる。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 * @param key オーバーレイ用キー
 */
export const createSakuraSpeech = (fetchImpl: typeof fetch, key: string): Voicevox => {
  const query = `?key=${encodeURIComponent(key)}`

  return {
    async checkReady() {
      await callWorker(fetchImpl, `${CHECK_PATH}${query}`, { method: 'POST' })
    },

    async synthesize(text) {
      const response = await callWorker(fetchImpl, `${SYNTHESIS_PATH}${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      return await response.blob()
    },
  }
}
