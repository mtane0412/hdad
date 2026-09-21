/**
 * アラートの素材（画像・動画・音声）
 *
 * 素材はR2（MEDIA）に置き、IDはアップロードのたびに新しく振る（同じIDの中身が変わらないので、ブラウザに長くキャッシュさせられる）。
 * 再配布できない素材をリポジトリに入れずに済むよう、配信者が管理画面からアップロードする。
 */
import type { MediaKind } from './alert-config'
import { HttpError, STATUS } from './http'
import type { MediaBucket, MediaObject } from './media-bucket'

/** 1ファイルの上限（バイト）。Workerのメモリ（128MB）に収まり、数十秒の動画が入る大きさ */
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024
const MAX_FILE_NAME_LENGTH = 200
const KINDS: readonly MediaKind[] = ['image', 'video', 'audio']

/** 管理画面に見せる素材1件 */
export interface MediaItem {
  id: string
  /** アップロード時のファイル名 */
  name: string
  kind: MediaKind
  contentType: string
  size: number
  uploadedAt: string
}

/** Content-Type（image/png; charset=... など）から素材の種類を決める。画像・動画・音声でなければ null */
export const kindOfContentType = (contentType: string): MediaKind | null => {
  const [type] = contentType.trim().toLowerCase().split('/')
  return KINDS.find((kind) => kind === type) ?? null
}

/** R2のオブジェクトを素材1件に変換する。このWorker以外が置いた、種類の分からないオブジェクトは null */
export const toMediaItem = (object: MediaObject): MediaItem | null => {
  const contentType = object.httpMetadata?.contentType ?? ''
  const kind = kindOfContentType(contentType)
  if (kind === null) return null
  return {
    id: object.key,
    name: object.customMetadata?.name ?? object.key,
    kind,
    contentType,
    size: object.size,
    uploadedAt: object.uploaded.toISOString(),
  }
}

/** すべての素材を、新しくアップロードした順に返す */
export const listMedia = async (bucket: MediaBucket): Promise<MediaItem[]> => {
  const items: MediaItem[] = []
  let cursor: string | undefined
  do {
    // R2の一覧は1回で全件返るとは限らないので、続きがある間は取りに行く
    const page = await bucket.list({ include: ['httpMetadata', 'customMetadata'], cursor })
    items.push(...page.objects.map(toMediaItem).filter((item) => item !== null))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor !== undefined)
  return items.sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt))
}

/**
 * アップロードのリクエスト（本文がファイルの中身、Content-Type が種類、X-File-Name がURLエンコードしたファイル名）を保存する。
 *
 * @throws HttpError ファイル名なし（400）・画像/動画/音声以外（415）・大きすぎる（413）・空（400）
 */
export const uploadMedia = async (bucket: MediaBucket, request: Request): Promise<MediaItem> => {
  const contentType = request.headers.get('Content-Type') ?? ''
  if (kindOfContentType(contentType) === null) {
    throw new HttpError(STATUS.unsupportedMediaType, 'unsupported-media', `画像・動画・音声のファイルだけをアップロードできます（Content-Type: ${contentType || 'なし'}）`)
  }

  let name: string
  try {
    name = decodeURIComponent(request.headers.get('X-File-Name') ?? '')
  } catch {
    throw new HttpError(STATUS.badRequest, 'invalid-file-name', 'X-File-Name ヘッダーはURLエンコードしたファイル名にしてください')
  }
  if (name === '' || name.length > MAX_FILE_NAME_LENGTH) {
    throw new HttpError(STATUS.badRequest, 'invalid-file-name', `X-File-Name ヘッダーに${MAX_FILE_NAME_LENGTH}文字以内のファイル名を指定してください`)
  }

  const tooLarge = new HttpError(STATUS.payloadTooLarge, 'too-large', `ファイルは ${MAX_MEDIA_BYTES / 1024 / 1024}MB 以内にしてください`)
  // 本文を読む前に弾けるものは弾く。Content-Length は偽れるので、読んだ後にも実際の大きさを確かめる
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_MEDIA_BYTES) throw tooLarge
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw tooLarge
  if (bytes.byteLength === 0) throw new HttpError(STATUS.badRequest, 'empty-file', 'ファイルの中身が空です')

  const id = crypto.randomUUID()
  await bucket.put(id, bytes, { httpMetadata: { contentType }, customMetadata: { name } })
  const saved = await bucket.head(id)
  const item = saved && toMediaItem(saved)
  if (!item) throw new Error(`素材「${name}」を保存できませんでした`)
  return item
}
