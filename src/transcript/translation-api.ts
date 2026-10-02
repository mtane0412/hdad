/**
 * 字幕の翻訳の呼び出し（Worker の POST /api/admin/translations）
 *
 * アプリの枠の音声認識が確定した1件を、直前の発話と一緒に Worker へ送り、英訳を受け取る（issue #191）。
 * 提供元は Worker が設定（/llm/ の「字幕の翻訳」）に従って決めるので、ここは送って受け取るだけである。
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、応答の形はここで確かめる。
 * 想定した形でなければエラーにする（Fail-Fast）。黙って「訳さない」ことにすると、訳が出ない原因に気付けない。
 */
import { createCaller, isRecord } from '../core/api'

const PATH = '/api/admin/translations'

export interface TranslationApi {
  /**
   * 確定した1件を英語に訳してもらう。
   *
   * @param context 直前に確定した発話（古いものから。最大2件）
   * @returns 訳文。訳さない設定なら null
   * @throws ApiError Worker が訳せなかった場合（理由は message）
   */
  translate(text: string, context: readonly string[]): Promise<string | null>
}

/**
 * 字幕の翻訳の呼び出しを組み立てる。
 *
 * 注意: セッションのクッキーと Origin ヘッダーはブラウザが付けるので、ここでは何も付けない（core/api.ts）。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 */
export const createTranslationApi = (fetchImpl: typeof fetch): TranslationApi => {
  const call = createCaller(fetchImpl)
  return {
    async translate(text, context) {
      const body = await call(PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, context }),
      })
      const translation: unknown = isRecord(body) ? body.translation : undefined
      if (translation !== null && typeof translation !== 'string') throw new Error('Workerの応答に translation がありません')
      return translation
    },
  }
}
