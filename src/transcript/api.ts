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
import { createCaller, isRecord } from '../core/api'

const PATH = '/api/overlay/transcript'

export interface TranscriptApi {
  /**
   * 確定した発話を1件送る。
   *
   * @returns 記録されたなら true。配信していなくてWorkerが捨てたなら false
   */
  send(messageId: string, text: string): Promise<boolean>
  /** 記録済みの発話を取り消す */
  remove(messageId: string): Promise<void>
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
    async remove(messageId) {
      await call(`${PATH}/${encodeURIComponent(messageId)}${query}`, { method: 'DELETE' })
    },
  }
}
