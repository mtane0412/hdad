/**
 * さくらのAI Engine の音声合成（VOICEVOX）の呼び出し
 *
 * チャットの読み上げの合成先にさくらを選んだとき（worker/speech-config.ts の engine が sakura。issue #225）に、
 * 読み上げのページから頼まれた1件を合成する。APIキーをブラウザに置けないので、合成は Worker が受け持つ。
 *
 * さくらには VOICEVOX ENGINE と同じ形の2段のAPIがあるので、src/speech/voicevox.ts と同じ流れで呼ぶ。
 * まず /tts/v1/audio_query で読み方を作らせ、その内容に読み上げ速度を差し込んでから /tts/v1/synthesis へ渡して
 * WAV を受け取る（再生速度で速さを変えると声の高さまで上がるため、合成の時点で指定する）。
 *
 * 注意: 課金されるのは合成（synthesis）したモーラ数の合計だけで、audio_query と失敗した呼び出しは数えられない
 * （2026-10-04 に実機で確認）。そのため起動時の確認（checkSpeaker）は audio_query だけで行う。
 * ENGINE と違い /version と /speakers は無い（404）ので、話者を一覧から選ばせることはできない。
 * 注意: 合成した WAV は加工せずに返す（MP3 への変換などで Worker の CPU 時間を使わないため）。
 * 注意: さくらの失敗は、さくらが返した理由（規約に同意していない話者の「This model is not available.」など）を
 * 添えて投げる。配信者がどこを直せばよいかを、読み上げのページの画面で見分けられるようにするためである。
 */
import { withTimeout } from './timeout'

/** さくらのAI Engine の起点 */
export const SAKURA_TTS_ORIGIN = 'https://api.ai.sakura.ad.jp'

/**
 * さくらの1回の呼び出しを待つ時間の上限（ミリ秒）。
 *
 * 合成は1回あたり0.2〜0.3秒で返る（実機で確認）。読み上げは1件ずつ順に行うので、黙った相手を待ち続けて
 * 後ろの発言まで止めないよう、値を引くだけの Twitch・Gyazo と同じ程度で切る。
 */
export const SAKURA_TTS_TIMEOUT_MS = 15_000

/**
 * 起動時の確認で読み方を作らせる文。
 *
 * audio_query は課金されないので中身は何でもよいが、空では断られうるため短い文を渡す。
 */
const CHECK_TEXT = 'てすと'

/** 失敗の文面に載せる応答本文の長さ。理由が読める程度にとどめる */
const MAX_ERROR_BODY_LENGTH = 200

/** 1件を合成するときの声の指定 */
export interface SakuraVoice {
  /** 話者ID（VOICEVOX のキャラクターとスタイルの組み合わせ） */
  readonly speaker: number
  /** 読み上げ速度（1 が標準） */
  readonly speed: number
}

/** さくらの音声合成 */
export interface SakuraTts {
  /**
   * 話者が使えることを、課金されない読み方の問い合わせだけで確かめる。
   *
   * @throws Error さくらが失敗を返した場合（APIキーの誤り・規約に同意していない話者など）
   */
  checkSpeaker(speaker: number): Promise<void>
  /**
   * 読み上げ文から音声（WAV）を作る。
   *
   * @returns さくらの合成の応答（本文が WAV）
   * @throws Error さくらが失敗を返した場合、または読み方の問い合わせの応答を読み取れない場合
   */
  synthesize(text: string, voice: SakuraVoice): Promise<Response>
}

/** 組み立てに必要なもの */
export interface SakuraTtsOptions {
  /** さくらへの通信。テストで差し替えられるよう引数で受け取る */
  readonly fetch: typeof fetch
  /** さくらのAPIキー（Workerのシークレット SAKURA_AI_API_KEY） */
  readonly apiKey: string
}

/** さくらが失敗を返したときの文面。さくらの理由を添える */
const sakuraError = async (response: Response, what: string): Promise<Error> => {
  const body = (await response.text()).slice(0, MAX_ERROR_BODY_LENGTH)
  return new Error(`さくらのAI Engine が${what}に失敗しました（${response.status}）: ${body}`)
}

/** さくらの音声合成の呼び出しを組み立てる */
export const createSakuraTts = ({ fetch: originalFetch, apiKey }: SakuraTtsOptions): SakuraTts => {
  // さくらが黙り続けたときに、待ち続けないようにする
  const fetchImpl = withTimeout(originalFetch, SAKURA_TTS_TIMEOUT_MS, 'さくらのAI Engine')
  const authorization = { Authorization: `Bearer ${apiKey}` }

  /** 読み方を作らせる。audio_query は POST だけを受け付ける */
  const audioQuery = async (text: string, speaker: number): Promise<Response> => {
    const url = `${SAKURA_TTS_ORIGIN}/tts/v1/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`
    const response = await fetchImpl(url, { method: 'POST', headers: authorization })
    if (!response.ok) throw await sakuraError(response, '読み方の問い合わせ')
    return response
  }

  return {
    async checkSpeaker(speaker) {
      await audioQuery(CHECK_TEXT, speaker)
    },

    async synthesize(text, { speaker, speed }) {
      const parsed: unknown = await (await audioQuery(text, speaker)).json()
      // 応答の形が変わっていたら、速度を差し込む先が無いことになるのでエラーにする（黙って標準速度で読まない）
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('さくらのAI Engine の読み方の問い合わせを読み取れませんでした')
      }
      const response = await fetchImpl(`${SAKURA_TTS_ORIGIN}/tts/v1/synthesis?speaker=${speaker}`, {
        method: 'POST',
        headers: { ...authorization, 'Content-Type': 'application/json', Accept: 'audio/wav' },
        body: JSON.stringify({ ...parsed, speedScale: speed }),
      })
      if (!response.ok) throw await sakuraError(response, '音声の合成')
      return response
    },
  }
}
