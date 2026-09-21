/**
 * Workerの呼び出しの共通部分
 *
 * ページUI（管理画面・ダッシュボード）はWorker（/api/*）を同じサイトの相対パスで呼び出す。
 * セッションのクッキーと、書き換えを伴うメソッドの Origin ヘッダーはブラウザが付けるので、ここでは何もしない。
 * worker/ のコードはブラウザ用のコードから読み込まない約束なので、応答の型は呼び出し側で定義し、受け取るたびに形を確かめる。
 * このファイルは、その「呼び出して本文を読む」「失敗をエラーにする」「一覧の形を確かめる」部分だけを持つ。
 *
 * 注意: 応答が想定した形でなければエラーにする（Fail-Fast）。黙って空の一覧にすると、記録や設定が消えたように見えてしまう。
 */

/** Workerが失敗を返した */
export class ApiError extends Error {
  override name = 'ApiError'

  /**
   * @param status HTTPの状態コード
   * @param code Workerのエラーコード（本文が想定した形でなければ 'unknown'）
   * @param problems 設定の検証で見つかった問題点（それ以外の失敗では空）
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly problems: readonly string[],
  ) {
    super(message)
  }
}

/** オブジェクト（null でない object）かどうか。応答の形を確かめる出発点 */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** Workerのエラー応答 { error: { code, message, problems? } } を ApiError にする。形が違えば状態コードだけを伝える */
const toApiError = (status: number, body: unknown): ApiError => {
  const error = isRecord(body) && isRecord(body.error) ? body.error : {}
  const code = typeof error.code === 'string' ? error.code : 'unknown'
  const message = typeof error.message === 'string' ? error.message : `Workerが ${status} を返しました`
  const problems = Array.isArray(error.problems) ? error.problems.filter((problem): problem is string => typeof problem === 'string') : []
  return new ApiError(status, code, message, problems)
}

/** 応答の本文から name の配列を取り出し、要素の形を確かめる */
export const readList = <T>(body: unknown, name: string, isItem: (value: unknown) => value is T): T[] => {
  const list: unknown = isRecord(body) ? body[name] : undefined
  if (!Array.isArray(list)) throw new Error(`Workerの応答に ${name} の配列がありません`)
  return list.map((item: unknown, index) => {
    if (!isItem(item)) throw new Error(`Workerの応答の ${name}[${index}] が想定した形ではありません`)
    return item
  })
}

/** Workerを呼び出して本文をJSONとして読む関数を作る。本文がなければ null、失敗の応答は ApiError にする */
export const createCaller = (fetchImpl: typeof fetch): ((path: string, init?: RequestInit) => Promise<unknown>) => {
  return async (path, init) => {
    const response = await fetchImpl(path, init)
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) throw toApiError(response.status, body)
    return body
  }
}
