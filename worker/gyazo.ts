/**
 * Gyazo への画像のアップロードと、読み取った文字の取得
 *
 * 配信画面を撮った1枚を Gyazo へ上げ（upload）、そこで作られるOCRのテキストをあとから取りに行く（fetchOcr）
 * ために使う（issue #122）。OCRをWorkerで動かす代わりに Gyazo に任せるのは、Workers AI の画像モデルに
 * 頼らずに日本語混じりの画面を読めるためである。ここは Gyazo の呼び出しだけを受け持ち、差分の抽出は持たない。
 *
 * 上げる（POST /api/overlay/screen のたび）のと取りに行く（cron が5分おき）のを分けているのは、上げた直後には
 * OCRの生成が終わっていない（実測で約10〜13秒）ためである。
 *
 * fetch を引数で受け取るのはテストで差し替えるためである（worker/twitch.ts と同じ形）。
 * 失敗はすべて GyazoApiError として投げ、呼び出し側が扱いを決める。
 *
 * 注意: access_policy は必ず only_me にする。配信画面は公開済みの映像ではあるが、人に見せる必要がないうえ、
 * 2026-09-11 に Gyazo が受けた不正アクセスでは画像のメタデータ（OCRのテキストと画像ID）が流出しているため、
 * 取り込む範囲を最小限にとどめる（docs/decisions/screen.md）。
 * 注意: 応答に image_id が無ければ失敗にする（Fail-Fast）。画像IDが無いとOCRを取りに行けないので、
 * 黙って成功扱いにすると、材料が貯まっていないことに配信が終わるまで気づけない。
 * 注意: 呼び出しには時間制限をかける（worker/timeout.ts）。Gyazo が黙り続けると、1回の収集で最大30枚を
 * 逐次に取りに行く道（worker/collect.ts の fetchScreenOcr）がそこで止まる（issue #126）。
 * 注意: OCRのテキストは metadata.ocr の下から読む。公式ドキュメントは ocr をトップレベルに置くと書いているが、
 * 実際の応答は違う（docs/decisions/screen.md）。ドキュメントどおりに書くと永久に空として扱ってしまう。
 */

import { withTimeout } from './timeout'

/**
 * Gyazo の1回の呼び出しを待つ時間の上限（ミリ秒）。
 *
 * OCRの取得は保存済みの値を引くだけだが、アップロードは画像（1枚あたり数百KB）を送るので、
 * Twitchの問い合わせ（TWITCH_TIMEOUT_MS）より長くとる（worker/timeout.ts。issue #126）。
 */
export const GYAZO_TIMEOUT_MS = 15_000

/** アップロードの受け口。Gyazo のAPIドキュメント（https://gyazo.com/api/docs/image）の upload */
const UPLOAD_URL = 'https://upload.gyazo.com/api/upload'

/** 1枚の情報を読む受け口。同ドキュメントの image。OCRのテキストはここから取る */
const IMAGE_URL = 'https://api.gyazo.com/api/images'

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

/** 上げ方の指定 */
export interface GyazoUploadOptions {
  /** 入れ先のコレクションID。空なら指定を送らない（どのコレクションにも入らない） */
  readonly collectionId?: string
}

export interface GyazoClient {
  /**
   * 画像を1枚上げる。
   *
   * @param image 画像の中身（Content-Type を持たせた Blob）
   * @param fileName Gyazo に渡すファイル名
   * @param options 入れ先のコレクションなど
   * @throws GyazoApiError Gyazo が失敗を返した、または応答に image_id が無かった場合
   */
  upload(image: Blob, fileName: string, options?: GyazoUploadOptions): Promise<GyazoUpload>

  /**
   * 上げた1枚から、Gyazo が読み取った文字を取る。
   *
   * @param imageId Gyazo が振った画像ID
   * @returns 読み取った文字。まだ生成されていなければ null
   * @throws GyazoApiError Gyazo が失敗を返した場合
   */
  fetchOcr(imageId: string): Promise<string | null>
}

export interface GyazoClientOptions {
  /** Gyazo のアクセストークン（https://gyazo.com/oauth/applications で発行する） */
  readonly accessToken: string
  /** 外への通信。テストで差し替えるために受け取る */
  readonly fetch: typeof fetch
  /** 1回の呼び出しを待つ時間の上限（ミリ秒）。既定は GYAZO_TIMEOUT_MS。短くできるのはテストのためである */
  readonly timeoutMs?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export const createGyazoClient = ({ accessToken, fetch: 元の通信, timeoutMs = GYAZO_TIMEOUT_MS }: GyazoClientOptions): GyazoClient => {
  // Gyazo が黙り続けたときに、1回の収集で最大30枚を逐次に取りに行く道がそこで止まらないようにする（issue #126）
  const fetchImpl = withTimeout(元の通信, timeoutMs, 'Gyazo')

  return {
    async upload(image, fileName, options = {}) {
      const form = new FormData()
      form.set('access_token', accessToken)
      form.set('imagedata', image, fileName)
      // 人に見せる必要がないので、URLを知っている人にも見せない
      form.set('access_policy', 'only_me')
      // OCRのテキストを含むメタデータを、誰でも読める形にしない
      form.set('metadata_is_public', 'false')
      // 入れ先の指定がないときは項目ごと送らない（空文字を送ると Gyazo がコレクションIDとして読もうとする）
      if (options.collectionId) form.set('collection_id', options.collectionId)

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

    async fetchOcr(imageId) {
      // 公式ドキュメントが示すとおり、アクセストークンはクエリで渡す
      const url = `${IMAGE_URL}/${encodeURIComponent(imageId)}?access_token=${encodeURIComponent(accessToken)}`
      const response = await fetchImpl(url)
      let body: unknown = null
      let 本文を読めた = true
      try {
        body = await response.json()
      } catch {
        本文を読めた = false
      }
      if (!response.ok) {
        const message = isRecord(body) && typeof body.message === 'string' ? body.message : '（本文を読めませんでした）'
        throw new GyazoApiError(response.status, `Gyazo からのOCRの取得が ${response.status} で失敗しました: ${message}`)
      }
      // 成功と返ってきたのに本文を読めないのは、Gyazo 側の異常（メンテナンスのHTMLなど）である。
      // ここで null を返すと「まだ生成されていない」と取り違え、上限まで数えたのち黙って諦めてしまう
      if (!本文を読めた) {
        throw new GyazoApiError(BAD_GATEWAY, 'Gyazo の応答を読めませんでした（JSONではありませんでした）')
      }

      const metadata: unknown = isRecord(body) ? body.metadata : undefined
      const ocr: unknown = isRecord(metadata) ? metadata.ocr : undefined
      const description: unknown = isRecord(ocr) ? ocr.description : undefined
      if (typeof description !== 'string') return null
      // 上げた直後は生成が終わっておらず空で返る。空白だけの読み取りも材料にならないので、同じく未生成として扱う
      const text = description.trim()
      return text === '' ? null : text
    },
  }
}

