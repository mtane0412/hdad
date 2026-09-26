/**
 * VOICEVOX ENGINE（同じPCで動く音声合成サーバー）の呼び出し
 *
 * 読み上げのページは OBS のブラウザソースとして、VOICEVOX と同じPCの上で開かれる前提で、その localhost へつなぐ
 * （ゆかコネNEO へつなぐ src/transcript/connection.ts と同じ考え方）。Workers AI に合成させないのは、
 * 発言のたびに無料枠を消費させないためである。
 *
 * つなぎ先（起点）は起動のときに決まるが、話者と読み上げ速度は合成のたびに受け取る。読み上げの設定は
 * Worker に置いてあり、配信中に管理画面から変えられるためである（issue #86）。
 *
 * ENGINE は2段で呼ぶ。まず /audio_query で読み方（アクセント・速度などの問い合わせ）を作らせ、
 * その内容に読み上げ速度を差し込んでから /synthesis へ渡して wav を受け取る。
 * 読み上げ速度を音声側（再生速度）で変えると声の高さまで上がってしまうため、合成の時点で指定する。
 * 音量は再生する側（audio.ts）が持つ（合成しなおさずに変えられるようにするため）。
 *
 * 注意: 失敗は黙って無音にせずエラーにする（Fail-Fast）。VOICEVOX を起動し忘れたまま配信を始めると、
 * 読み上げが動いていないことに気づけないためである。fetch を引数で受け取るのはテストで差し替えるため。
 *
 * 注意: ENGINE は既定（`--cors_policy_mode localapps`）では localhost・`app://`・ブラウザ拡張からの通信しか
 * 受け付けないので、このサイト（https のオリジン）からの fetch は拒まれる。文字起こしの中継ページが同じ
 * ループバックへつながるのは WebSocket が CORS の対象外だからで、fetch には同じ理屈が通らない。
 * 配信者が設定ページ（`<ENGINEの起点>/setting`）でこのサイトのオリジンを許可し、ENGINE を再起動する必要がある。
 * つながらない理由はブラウザからは見分けられないので（どれも `TypeError: Failed to fetch` になる）、
 * 考えられる原因と直し方をすべて文面に並べる。
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
   * @param text 読み上げ文
   * @param voice そのとき有効な声の設定。合成のたびに受け取るのは、配信中に管理画面から変えられるようにするため
   * @throws ENGINE が失敗を返した場合、またはつながらない場合
   */
  synthesize(text: string, voice: SpeechVoice): Promise<Blob>
}

/** 1件を合成するときの声の指定 */
export interface SpeechVoice {
  /** 話者ID（VOICEVOX のキャラクターとスタイルの組み合わせ） */
  readonly speaker: number
  /** 読み上げ速度（1 が標準） */
  readonly speed: number
}

/** ENGINE へのつなぎ先。起動のときに決まり、途中では変えられない（変えるにはOBSの再読み込みが要る） */
export interface VoicevoxOptions {
  /** ENGINE の起点（http://localhost:50021） */
  readonly origin: string
  /** このページのオリジン。つながらないときに、ENGINE で許可すべきオリジンとして文面に出す */
  readonly pageOrigin: string
}

/** ENGINE の起点を組み立てる。ループバックなので http でよい（混在コンテンツはブラウザが例外扱いする） */
export const voicevoxOrigin = (host: string, port: number): string => `http://${host}:${port}`

/** つながらなかったときに、OBSの画面へ出す文面。考えられる原因を、多い順に直し方つきで並べる */
const notReachableMessage = (url: string, origin: string, pageOrigin: string, error: unknown): string =>
  [
    `VOICEVOX（${url}）につながりません。考えられる原因は次の3つです。`,
    `1. VOICEVOX が起動していない → 起動してから、このブラウザソースを再読み込みしてください`,
    `2. ポート番号が違う → 管理画面の「読み上げ」で VOICEVOX が使っているポートに直し、このブラウザソースを再読み込みしてください`,
    `3. VOICEVOX がこのサイトからの通信を拒んでいる → ${origin}/setting を開いて CORS の許可に ${pageOrigin} を足し、VOICEVOX を再起動してください`,
    `詳細: ${String(error)}`,
  ].join('\n')

/** 通信そのものの失敗（ENGINE が動いていない・拒まれた）も、応答の失敗も、同じ呼び名で包んで投げる */
const callEngine = async (
  fetchImpl: typeof fetch,
  { url, origin, pageOrigin, what }: { url: string; origin: string; pageOrigin: string; what: string },
  init: RequestInit,
): Promise<Response> => {
  let response: Response
  try {
    response = await fetchImpl(url, init)
  } catch (error) {
    throw new Error(notReachableMessage(url, origin, pageOrigin, error), { cause: error })
  }
  if (!response.ok) throw new Error(`VOICEVOX が${what}に失敗しました（${response.status}）`)
  return response
}

/**
 * VOICEVOX ENGINE の呼び出しを組み立てる。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 */
export const createVoicevox = (fetchImpl: typeof fetch, { origin, pageOrigin }: VoicevoxOptions): Voicevox => {
  /** どの呼び出しでも同じ、失敗の文面に使う情報 */
  const engine = { origin, pageOrigin }

  return {
    async checkReady() {
      await callEngine(fetchImpl, { ...engine, url: `${origin}/version`, what: 'バージョンの読み出し' }, { method: 'GET' })
    },

    async synthesize(text, { speaker, speed }) {
      const speakerQuery = `speaker=${speaker}`
      const queryResponse = await callEngine(
        fetchImpl,
        { ...engine, url: `${origin}/audio_query?${speakerQuery}&text=${encodeURIComponent(text)}`, what: '読み方の問い合わせ' },
        { method: 'POST' },
      )
      const parsed: unknown = await queryResponse.json()
      // 応答の形が変わっていたら、速度を差し込む先が無いことになるのでエラーにする（黙って標準速度で読まない）
      if (typeof parsed !== 'object' || parsed === null) throw new Error('VOICEVOX の読み方の問い合わせを読み取れませんでした')
      const query: AudioQuery = { ...parsed, speedScale: speed }

      const audioResponse = await callEngine(
        fetchImpl,
        { ...engine, url: `${origin}/synthesis?${speakerQuery}`, what: '音声の合成' },
        { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'audio/wav' }, body: JSON.stringify(query) },
      )
      return await audioResponse.blob()
    },
  }
}
