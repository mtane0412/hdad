/**
 * 素材（画像・動画・音声）の置き場所
 *
 * 実体は Cloudflare R2（wrangler.jsonc の MEDIA）。Workerのコードが使う範囲だけを型として宣言し、
 * テストではメモリ上の実装（fake-bucket.ts）に差し替える。メソッドの形はR2のバケットに合わせてある。
 *
 * 素材の種類（Content-Type）は httpMetadata に、アップロード時のファイル名は customMetadata.name に持たせる。
 */
export interface MediaMetadata {
  httpMetadata?: { contentType?: string }
  customMetadata?: Record<string, string>
}

export interface MediaObject extends MediaMetadata {
  key: string
  /** バイト数 */
  size: number
  /** アップロードした日時 */
  uploaded: Date
}

export interface MediaObjectBody extends MediaObject {
  body: ReadableStream
}

export interface MediaBucket {
  put(key: string, value: ArrayBuffer, options: MediaMetadata): Promise<unknown>
  get(key: string): Promise<MediaObjectBody | null>
  head(key: string): Promise<MediaObject | null>
  /** 注意: R2は include を指定しないと httpMetadata と customMetadata を返さない */
  list(options: { include: ('httpMetadata' | 'customMetadata')[]; cursor?: string }): Promise<{
    objects: MediaObject[]
    truncated: boolean
    cursor?: string
  }>
  delete(key: string): Promise<void>
}
