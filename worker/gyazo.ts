/**
 * Gyazo への画像のアップロード
 *
 * 配信画面を撮った1枚を Gyazo へ上げ、そこで作られるOCRのテキストをあとから取りに行くために使う（issue #122）。
 * OCRをWorkerで動かす代わりに Gyazo に任せるのは、Workers AI の画像モデルに頼らずに日本語混じりの画面を
 * 読めるためである。ここはアップロードだけを受け持ち、OCRの取得も差分の抽出も持たない。
 *
 * fetch を引数で受け取るのはテストで差し替えるためである（worker/twitch.ts と同じ形）。
 * 失敗はすべて GyazoApiError として投げ、呼び出し側が扱いを決める。
 *
 * 注意: access_policy は必ず only_me にする。配信画面は公開済みの映像ではあるが、人に見せる必要がないうえ、
 * 2026-09-11 に Gyazo が受けた不正アクセスでは画像のメタデータ（OCRのテキストと画像ID）が流出しているため、
 * 取り込む範囲を最小限にとどめる（docs/decisions/screen.md）。
 * 注意: 応答に image_id が無ければ失敗にする（Fail-Fast）。画像IDが無いとOCRを取りに行けないので、
 * 黙って成功扱いにすると、材料が貯まっていないことに配信が終わるまで気づけない。
 */

/** アップロードの受け口。Gyazo のAPIドキュメント（https://gyazo.com/api/docs/image）の upload */
const UPLOAD_URL = 'https://upload.gyazo.com/api/upload'

/** Gyazo が失敗を返した、または応答が想定した形でなかった */
export class GyazoApiError extends Error {
  override name = 'GyazoApiError'

  /** @param status Gyazo が返したHTTPの状態コード（応答の形の誤りでは 502） */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Gyazo の応答として成り立っていない（必要な項目がない）ときに使う状態コード */
const BAD_GATEWAY = 502

/** 上げた1枚 */
export interface GyazoUpload {
  /** Gyazo が振った画像ID。OCRを取りに行くときの鍵になる */
  readonly imageId: string
  /** 配信者が自分で中身を確かめるためのURL */
  readonly permalinkUrl: string
}

export interface GyazoClient {
  /**
   * 画像を1枚上げる。
   *
   * @param image 画像の中身（Content-Type を持たせた Blob）
   * @param fileName Gyazo に渡すファイル名
   * @throws GyazoApiError Gyazo が失敗を返した、または応答に image_id が無かった場合
   */
  upload(image: Blob, fileName: string): Promise<GyazoUpload>
}

export interface GyazoClientOptions {
  /** Gyazo のアクセストークン（https://gyazo.com/oauth/applications で発行する） */
  readonly accessToken: string
  /** 外への通信。テストで差し替えるために受け取る */
  readonly fetch: typeof fetch
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export const createGyazoClient = ({ accessToken, fetch: fetchImpl }: GyazoClientOptions): GyazoClient => ({
  async upload(image, fileName) {
    const form = new FormData()
    form.set('access_token', accessToken)
    form.set('imagedata', image, fileName)
    // 人に見せる必要がないので、URLを知っている人にも見せない
    form.set('access_policy', 'only_me')
    // OCRのテキストを含むメタデータを、誰でも読める形にしない
    form.set('metadata_is_public', 'false')

    const response = await fetchImpl(UPLOAD_URL, { method: 'POST', body: form })
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const message = isRecord(body) && typeof body.message === 'string' ? body.message : '（本文を読めませんでした）'
      throw new GyazoApiError(response.status, `Gyazo へのアップロードが ${response.status} で失敗しました: ${message}`)
    }

    const imageId: unknown = isRecord(body) ? body.image_id : undefined
    if (typeof imageId !== 'string' || imageId === '') {
      throw new GyazoApiError(BAD_GATEWAY, 'Gyazo の応答に image_id がありません')
    }
    const permalinkUrl: unknown = isRecord(body) ? body.permalink_url : undefined
    return { imageId, permalinkUrl: typeof permalinkUrl === 'string' ? permalinkUrl : '' }
  },
})
