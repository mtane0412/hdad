/**
 * VOICEVOX ENGINE（同じPCで動く音声合成サーバー）の呼び出し
 *
 * 読み上げのページは OBS のブラウザソースとして、VOICEVOX と同じPCの上で開かれる前提で、その localhost へつなぐ
 * （ゆかコネNEO へつなぐ src/transcript/connection.ts と同じ考え方）。Workers AI に合成させないのは、
 * 発言のたびに無料枠を消費させないためである。
 *
 * ENGINE は2段で呼ぶ。まず /audio_query で読み方（アクセント・速度などの問い合わせ）を作らせ、
 * その内容に読み上げ速度を差し込んでから /synthesis へ渡して wav を受け取る。
 * 読み上げ速度を音声側（再生速度）で変えると声の高さまで上がってしまうため、合成の時点で指定する。
 * 音量は再生する側（audio.ts）が持つ（合成しなおさずに変えられるようにするため）。
 *
 * 注意: 失敗は黙って無音にせずエラーにする（Fail-Fast）。VOICEVOX を起動し忘れたまま配信を始めると、
 * 読み上げが動いていないことに気づけないためである。fetch を引数で受け取るのはテストで差し替えるため。
 */

/** 読み方の問い合わせ（/audio_query の応答）。速度を差し替えるだけなので、中身は触らずそのまま渡す */
type AudioQuery = Record<string, unknown>

export interface Voicevox {
  /**
   * ENGINE につながることを確かめる。
   *
   * @throws つながらない場合（VOICEVOX が起動していない・ポートが違う）
   */
  checkReady(): Promise<void>
  /**
   * 読み上げ文から音声（wav）を作る。
   *
   * @throws ENGINE が失敗を返した場合、またはつながらない場合
   */
  synthesize(text: string): Promise<Blob>
}

export interface VoicevoxOptions {
  /** ENGINE の起点（http://localhost:50021） */
  readonly origin: string
  /** 話者ID（VOICEVOX のキャラクターとスタイルの組み合わせ） */
  readonly speaker: number
  /** 読み上げ速度（1 が標準） */
  readonly speed: number
}

/** ENGINE の起点を組み立てる。ループバックなので http でよい（混在コンテンツはブラウザが例外扱いする） */
export const voicevoxOrigin = (host: string, port: number): string => `http://${host}:${port}`

/** 通信そのものの失敗（ENGINE が動いていない）も、応答の失敗も、同じ呼び名で包んで投げる */
const callEngine = async (fetchImpl: typeof fetch, url: string, init: RequestInit, what: string): Promise<Response> => {
  let response: Response
  try {
    response = await fetchImpl(url, init)
  } catch (error) {
    throw new Error(`VOICEVOX（${url}）につながりません。VOICEVOX が起動しているか、ポート番号が合っているかを確かめてください: ${String(error)}`, { cause: error })
  }
  if (!response.ok) throw new Error(`VOICEVOX が${what}に失敗しました（${response.status}）`)
  return response
}

/**
 * VOICEVOX ENGINE の呼び出しを組み立てる。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 */
export const createVoicevox = (fetchImpl: typeof fetch, { origin, speaker, speed }: VoicevoxOptions): Voicevox => {
  const speakerQuery = `speaker=${speaker}`

  return {
    async checkReady() {
      await callEngine(fetchImpl, `${origin}/version`, { method: 'GET' }, 'バージョンの読み出し')
    },

    async synthesize(text) {
      const queryResponse = await callEngine(
        fetchImpl,
        `${origin}/audio_query?${speakerQuery}&text=${encodeURIComponent(text)}`,
        { method: 'POST' },
        '読み方の問い合わせ',
      )
      const parsed: unknown = await queryResponse.json()
      // 応答の形が変わっていたら、速度を差し込む先が無いことになるのでエラーにする（黙って標準速度で読まない）
      if (typeof parsed !== 'object' || parsed === null) throw new Error('VOICEVOX の読み方の問い合わせを読み取れませんでした')
      const query: AudioQuery = { ...parsed, speedScale: speed }

      const audioResponse = await callEngine(
        fetchImpl,
        `${origin}/synthesis?${speakerQuery}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'audio/wav' }, body: JSON.stringify(query) },
        '音声の合成',
      )
      return await audioResponse.blob()
    },
  }
}
