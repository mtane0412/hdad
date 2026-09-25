/**
 * 文字起こしの送信（オーバーレイ用API の呼び出し）
 *
 * 中継ページ（transcript/index.html）は素材ページなのでログインを持たず、アラートのオーバーレイと同じ
 * オーバーレイ用キー（URLの ?key=）で Worker に受け付けてもらう。
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、応答の型はここで定義して形を確かめる。
 * 想定した形でなければエラーにする（Fail-Fast）。黙って「記録された」ことにすると、あらすじの材料が
 * 貯まっていないことに配信が終わるまで気づけない。
 */
import { ApiError, createCaller, isRecord } from '../core/api'

const PATH = '/api/overlay/transcript'

export interface TranscriptApi {
  /**
   * 確定した発話を1件送る。
   *
   * @returns 記録されたなら true。配信していなくてWorkerが捨てたなら false
   */
  send(messageId: string, text: string): Promise<boolean>
}

/**
 * 文字起こしの送信を組み立てる。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 * @param key オーバーレイ用キー
 */
export const createTranscriptApi = (fetchImpl: typeof fetch, key: string): TranscriptApi => {
  const call = createCaller(fetchImpl)
  const query = `?key=${encodeURIComponent(key)}`

  return {
    async send(messageId, text) {
      const body = await call(`${PATH}${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, text }),
      })
      const recorded: unknown = isRecord(body) ? body.recorded : undefined
      if (typeof recorded !== 'boolean') throw new Error('Workerの応答に recorded がありません')
      return recorded
    },
  }
}

/**
 * この失敗は、同じ1件をもう一度送れば直るかどうか。
 *
 * ゆかコネNEO は確定した1件を、表示の残り時間が尽きるまで繰り返し押し出してくる。送信に失敗した発話を
 * 忘れる（message.ts の forgetTranscript）とその押し出しで送り直されるので、直る見込みのない失敗まで
 * 忘れると、同じ失敗を何度も繰り返して画面がお知らせで埋まってしまう。
 *
 * Worker が本文の誤り（長すぎる・空）やキーの誤りとして4xxを返したなら、同じものを送り直しても
 * 同じ答えが返る。通信そのものの失敗と、Worker 側の不具合（5xx）だけをやり直す。
 */
export const isRetryable = (error: unknown): boolean => {
  if (!(error instanceof ApiError)) return true
  return error.status >= 500
}
