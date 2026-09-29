/**
 * 描く画面の背景（配信画面を撮った最新の1枚）の保管
 *
 * 描く画面（/draw/）のキャンバスの下に、配信画面を薄く敷くための画像を持つ。画像は画面の取り込み
 * （POST /api/overlay/screen。worker/overlay-routes.ts の postScreen）で届いたものを、配信中に限って
 * 手書きの中継先（worker/draw-channel.ts の DrawChannel）の storage に置く。持つのは最新の1枚だけである。
 *
 * 配信していないときは置き換えないので、そのあいだは最後に配信した時点の1枚が残る。配信していないときの
 * 1枚は Worker が Gyazo へ上げずに捨てている（配信前の準備画面を残さないため）ので、それに揃えている。
 * そのおかげで、配信していないときに撮られても Durable Object を起こさず、費用が増えない。
 *
 * 注意: Durable Object の storage は1件（鍵と値の合計）が2MBまでなので、画像を切り分けて置く。
 * 画面の取り込みは最大8MB（SCREEN_MAX_BYTES）まで受け付けるため、1件に収まるとは限らない。
 * 注意: ここは storage の読み書きだけを持ち、HTTPの形（ETagなど）は DrawChannel が持つ。
 */

/** 背景の1枚 */
export interface DrawBackground {
  readonly image: Uint8Array
  /** 画像の形式（image/png か image/jpeg） */
  readonly contentType: string
  /** 撮った時刻（ミリ秒）。描く画面が「いつの画面か」を出すのと、変わったかを見分けるのに使う */
  readonly capturedAt: number
}

/** 置くときに受け取る1枚。届いた本文をそのまま渡せるよう ArrayBuffer で受ける */
export interface DrawBackgroundInput {
  readonly image: ArrayBuffer
  readonly contentType: string
  readonly capturedAt: number
}

/**
 * 背景を置く storage。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * Cloudflare の DurableObjectStorage はこの形を満たす。
 */
export interface BackgroundStorage {
  get<T>(key: string): Promise<T | undefined>
  put(entries: Record<string, unknown>): Promise<void>
  delete(keys: string[]): Promise<number>
}

/** 1枚の説明（形式・撮った時刻・切れ端の数）を置く鍵 */
const META_KEY = 'background'

/** 切れ端を置く鍵 */
const chunkKey = (index: number): string => `${META_KEY}:${index}`

/**
 * 切れ端1つの大きさ（バイト）。
 *
 * storage の1件の上限（2MB）に鍵の長さのぶんの余裕を残す。画面の取り込みの上限（8MB）でも
 * 切れ端は9つで、1度に書ける件数（128件）に収まる。
 */
export const BACKGROUND_CHUNK_BYTES = 1024 * 1024

interface BackgroundMeta {
  readonly contentType: string
  readonly capturedAt: number
  readonly chunks: number
}

/**
 * 背景の1枚を置き換える。
 *
 * @param chunkBytes 切れ端1つの大きさ。テストで小さくして切り分けを確かめるためだけに受け取る
 */
export const saveDrawBackground = async (storage: BackgroundStorage, background: DrawBackgroundInput, chunkBytes = BACKGROUND_CHUNK_BYTES): Promise<void> => {
  const 前の説明 = await storage.get<BackgroundMeta>(META_KEY)
  const 切れ端の数 = Math.ceil(background.image.byteLength / chunkBytes)
  const entries: Record<string, unknown> = {
    [META_KEY]: { contentType: background.contentType, capturedAt: background.capturedAt, chunks: 切れ端の数 } satisfies BackgroundMeta,
  }
  for (let i = 0; i < 切れ端の数; i += 1) entries[chunkKey(i)] = new Uint8Array(background.image.slice(i * chunkBytes, (i + 1) * chunkBytes))
  // 説明と切れ端を1度に書く（1度の put は丸ごと書かれるので、説明と切れ端の数が食い違わない）
  await storage.put(entries)
  // 前の1枚のほうが切れ端が多ければ、余ったものを消す（残しても読まれないが、storage を無駄に占める）
  const 余り = Array.from({ length: Math.max(0, (前の説明?.chunks ?? 0) - 切れ端の数) }, (_, i) => chunkKey(切れ端の数 + i))
  if (余り.length > 0) await storage.delete(余り)
}

/**
 * 背景の1枚を読む。
 *
 * @returns 一度も置いていなければ null
 * @throws 説明はあるのに切れ端が欠けている場合（黙って欠けた画像を返すと、壊れた背景が出る原因に気付けない）
 */
export const loadDrawBackground = async (storage: BackgroundStorage): Promise<DrawBackground | null> => {
  const 説明 = await storage.get<BackgroundMeta>(META_KEY)
  if (説明 === undefined) return null
  const 切れ端 = await Promise.all(Array.from({ length: 説明.chunks }, (_, i) => storage.get<Uint8Array>(chunkKey(i))))
  const 大きさ = 切れ端.reduce((合計, 片) => 合計 + (片?.byteLength ?? 0), 0)
  const image = new Uint8Array(大きさ)
  let 位置 = 0
  for (const [i, 片] of 切れ端.entries()) {
    if (片 === undefined) throw new Error(`手書きの背景の ${i + 1} 番目の切れ端がありません`)
    image.set(片, 位置)
    位置 += 片.byteLength
  }
  return { image, contentType: 説明.contentType, capturedAt: 説明.capturedAt }
}
